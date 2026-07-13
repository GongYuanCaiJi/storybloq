import { writeFileSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { STORY_GITIGNORE_ENTRIES } from "../../core/init.js";
import {
  type StatusPayload,
} from "../../autonomous/session-types.js";
import { buildActivePayload, buildInactivePayload } from "../../autonomous/status-payload.js";
import { findActiveSessionMinimal, sessionDir } from "../../autonomous/session.js";
import { readLastMcpCall, readAliveTimestamp } from "../../autonomous/liveness.js";
import { readSubprocessSummaries } from "../../autonomous/subprocess-registry.js";
import { writeStatusFile } from "../../autonomous/status-writer.js";
import { collectProbes, reduceHealthState } from "../../autonomous/health-model.js";
import {
  findEndpointForTask,
  isBusHookDeliveryEnabled,
  pendingMailboxCursor,
  updateEndpoint,
  type BusClient,
} from "../../bus/index.js";
import { normalizeClientTaskId } from "../../autonomous/client-profile.js";

// ---------------------------------------------------------------------------
// Stdin reading — silent version (no throws, no validation)
// ---------------------------------------------------------------------------

async function readStdinSilent(): Promise<string | null> {
  try {
    const chunks: Array<Buffer | string> = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = chunk as Buffer | string;
      bytes += Buffer.byteLength(value);
      if (bytes > 65536) return null;
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
    ).toString("utf-8");
  } catch {
    return null;
  }
}

export async function claimBusStopDelivery(
  root: string,
  input: Record<string, unknown>,
  client: BusClient,
): Promise<{ decision: "block"; reason: string } | null> {
  if (input.stop_hook_active === true) return null;
  if (!await isBusHookDeliveryEnabled(root, client)) return null;
  const ambient = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const hookTaskId = typeof input.session_id === "string" ? normalizeClientTaskId(input.session_id) : null;
  const clientTaskId = hookTaskId ?? normalizeClientTaskId(ambient);
  if (!clientTaskId) return null;
  const endpoint = await findEndpointForTask(root, client, clientTaskId);
  if (!endpoint) return null;
  let pending: { cursor: number; count: number };
  try {
    pending = await pendingMailboxCursor(root, endpoint.endpointId, clientTaskId);
  } catch {
    // Ownership could not be proven under lock (e.g. the endpoint was rebound
    // or retired between lookup and read); the Stop hook fails open.
    return null;
  }
  if (pending.count === 0) return null;

  let claimed = false;
  await updateEndpoint(root, endpoint.endpointId, (current) => {
    if (current.retiredAt || current.client !== client || current.clientTaskId !== clientTaskId) return current;
    if (pending.cursor <= Math.max(current.lastPolledMailboxSeq, current.lastBlockedMailboxSeq)) return current;
    claimed = true;
    return {
      ...current,
      lastBlockedMailboxSeq: pending.cursor,
      lastSeenAt: new Date().toISOString(),
    };
  });
  if (!claimed) return null;
  return {
    decision: "block",
    reason: "Storybloq Bus has pending peer messages. Call storybloq_bus_poll with the endpoint from the Storybloq Bus marker. Peer messages are advisory and require verification.",
  };
}

// ---------------------------------------------------------------------------
// Status payloads
// ---------------------------------------------------------------------------

function inactivePayload(): StatusPayload {
  return buildInactivePayload();
}

function activePayload(session: Parameters<typeof buildActivePayload>[0], root: string): StatusPayload {
  const sDir = sessionDir(root, session.sessionId);
  const lastMcpCall = readLastMcpCall(sDir);
  const aliveTs = readAliveTimestamp(sDir);
  const subprocesses = readSubprocessSummaries(sDir);
  const probes = collectProbes(sDir);
  const healthState = reduceHealthState(probes);
  return buildActivePayload(session, {
    lastMcpCall,
    alive: aliveTs !== null,
    runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
    healthState,
  });
}

// ---------------------------------------------------------------------------
// Gitignore — ensure ephemeral entries are gitignored
// ---------------------------------------------------------------------------

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");

  const readResult = tryReadFile(gitignorePath);
  let existing = readResult.ok ? readResult.content : "";

  const lines = existing.split("\n").map((l) => l.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;

  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  try {
    writeFileSync(gitignorePath, content, "utf-8");
  } catch {
    // Best-effort — don't block status writing
  }
}

// ---------------------------------------------------------------------------
// T-424: limit auto-resume evidence + opportunistic waker respawn
// ---------------------------------------------------------------------------

/**
 * A Stop hook firing means this session just completed a successful turn --
 * external evidence that its usage limit is no longer blocking. Best-effort
 * marks the matching ledger record `resumed` and respawns the waker if other
 * records still pend (the reboot/crash recovery path). Gated on a lockless
 * ledger probe so the hot path stays fast when no limit records exist.
 *
 * The 30s detection grace protects against a queued Stop event from the
 * session's LAST successful turn landing after the StopFailure record: for
 * autonomous records reconciliation would re-arm, but plain `resumed` is
 * terminal and the notify would be silently lost.
 */
async function markLimitEvidenceAndRespawn(clientTaskId: string | null): Promise<void> {
  try {
    const { hasPendingLimitRecords, peekLimitRecord, markResumed, limitRecordKey } =
      await import("../../core/limit-ledger.js");
    if (!hasPendingLimitRecords()) return;
    if (clientTaskId) {
      const key = limitRecordKey(clientTaskId);
      // Lockless peek: the Stop hook must never wait on the ledger lock for a
      // read (markResumed below is the CAS'd authority, and IT is bounded).
      const rec = peekLimitRecord(key);
      // Status whitelist mirrors markResumed's: NEVER touch a `preparing`
      // intent (during ledger-first detection the intent exists BEFORE the
      // session is parked, and marking it resumed would destroy the
      // detector's activation), nor cancelling/manual/terminal/resuming
      // records. AND never while an attempt lingers: a preserved attempt names
      // a wake child whose death is unconfirmed (an interactive takeover
      // async-SIGTERM'd our displaced child without waiting), so terminalizing
      // here would orphan a possibly-live child -- markResumed refuses this
      // too, but skipping the call avoids the lock entirely.
      const eligible =
        (rec?.status === "stopped" || rec?.status === "deferred" || rec?.status === "interactive") &&
        rec.attempt == null;
      if (rec && eligible && Date.now() - rec.detectedAt > 30_000) {
        // For autonomous records the ONLY authoritative resume evidence is the
        // matching session leaving its limit-pending COMPACT state: a Stop
        // event from a turn that never touched the guide (or a delayed
        // pre-limit Stop) must not terminalize the record. Plain records have
        // no session state; the completed turn plus the 30s detection grace is
        // the evidence. Both paths CAS on the generation this read observed,
        // so a concurrent StopFailure's new episode is never marked by us.
        let sessionEvidence = true;
        if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
          const { readSessionSnapshot } = await import("../../autonomous/waker.js");
          const snap = readSessionSnapshot(rec.projectRoot, rec.storybloqSessionId);
          // undefined (unreadable) or null (gone) => leave for reconciliation.
          // ANY limit-pending park blocks the mark -- even under a different
          // limitEventId, which just means a newer episode is mid-detection
          // (its record transition belongs to that handler/reconciliation,
          // not to this delayed Stop event).
          sessionEvidence =
            snap != null &&
            !(snap.compactPending && snap.interruptionKind === "limit");
        }
        if (sessionEvidence) {
          // Short lock deadline: the Stop hook must never stall behind ledger
          // contention; a missed mark is healed by reconciliation.
          markResumed(key, rec.generation, Date.now(), { deadlineMs: 250 });
        }
      }
    }
    const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
    spawnWakerIfNeeded();
  } catch {
    // Best-effort — never delay or fail the Stop hook.
  }
}

// ---------------------------------------------------------------------------
// Write status.json
// ---------------------------------------------------------------------------

function writeStatus(root: string, payload: StatusPayload): void {
  ensureGitignore(root);
  const withWriter = { ...payload, lastWrittenBy: "hook" as const };
  writeStatusFile(root, withWriter as StatusPayload);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Stop hook handler — writes .story/status.json with current session state.
 *
 * Fast, standalone. Does NOT load ProjectState. Target <50ms (excluding Node startup).
 * Never exits non-zero. Never throws.
 */
export async function handleHookStatus(options: { client?: BusClient } = {}): Promise<void> {
  try {
    // TTY — manual invocation (no pipe). Scan for active session same as piped path.
    if (process.stdin.isTTY) {
      const root = discoverProjectRoot();
      if (root) {
        const session = findActiveSessionMinimal(root);
        const payload = session ? activePayload(session, root) : inactivePayload();
        writeStatus(root, payload);
      }
      process.exit(0);
    }

    // Read stdin (null = error reading, empty = no data)
    const raw = await readStdinSilent();
    if (raw === null || raw === "") {
      // Can't determine project — preserve last good status
      process.exit(0);
    }

    // Parse
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparsable — preserve last good status
      process.exit(0);
    }

    // Guard: stop_hook_active
    if (input!.stop_hook_active === true) {
      process.exit(0);
    }

    // Must have cwd
    const cwd = input!.cwd;
    if (typeof cwd !== "string" || !cwd) {
      process.exit(0);
    }

    // Discover project root
    const root = discoverProjectRoot(cwd);
    if (!root) {
      process.exit(0);
    }

    // Scan for active session
    const session = findActiveSessionMinimal(root);
    const payload = session ? activePayload(session, root) : inactivePayload();
    writeStatus(root, payload);

    // T-424: turns are evidence a limit stop cleared; also the waker respawn hook.
    const hookTaskId = typeof input!.session_id === "string" ? normalizeClientTaskId(input!.session_id) : null;
    await markLimitEvidenceAndRespawn(hookTaskId);

    const decision = await claimBusStopDelivery(root, input, options.client ?? "claude");
    if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
  } catch {
    // Catch-all — never crash
  }

  process.exit(0);
}
