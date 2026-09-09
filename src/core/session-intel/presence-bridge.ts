/**
 * T-499: the presence bridge -- everything that reads or writes the
 * `sessionIntel` subtree of a presence record from the heavy path.
 *
 *   caller binding      may THIS process push or persist for a session?
 *   target provenance   which era and capture does the TARGET session have?
 *   reconciliation      apply compaction boundaries and pending files under
 *                       the record lock, returning complete | incomplete;
 *   persistence rule    accept a sample only when it provably describes the
 *                       file the record describes (era, revision, incarnation,
 *                       baseline anchor, incoming anchor, byte order);
 *   handover stamp      record a handover against the current boundary.
 *
 * Every locked section goes through `applyPresenceEnrichment` so the presence
 * hook's own lock and atomic write are the only primitives used.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS, TRY_LOCK_BUDGET_MS, type EnrichmentOutcome } from "../presence-enrichment.js";
import { currentClientTaskId, currentStorybloqClient } from "../../autonomous/client-profile.js";
import { presenceDirIfPresent, readBoundedNoFollow, directoryIdentity, ensureTelemetrySubdir, removeRegularFile, telemetrySubdirIfPresent } from "../../presence/io.js";
import { parsePresenceRecord } from "../../presence/record.js";
import { MAX_RECORD_BYTES, presenceFileBase, type SessionPresence } from "../../presence/types.js";
import { emptySessionIntel, type Epoch, type SessionIntelPresence, type SessionIntelSample } from "../../presence/session-intel-fields.js";
import type { SessionIntelConfig } from "./config.js";
import { readEra, type EraEntry } from "./era-store.js";
import { processEra, type ProcessCheck, type ProcessEraResolver } from "./process-era.js";
import { anchorsStillMatch, scanBackwardForBoundary } from "./transcript-scan.js";
import type { TargetProvenance, TokenPressureSample, TranscriptBoundary } from "./types.js";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readPresenceRecord(root: string, sessionId: string): SessionPresence | null {
  const dir = presenceDirIfPresent(root);
  if (!dir) return null;
  const text = readBoundedNoFollow(join(dir, `${presenceFileBase(sessionId)}.json`), MAX_RECORD_BYTES);
  return text === null ? null : parsePresenceRecord(text, sessionId);
}

/**
 * Provenance for the TARGET session, never the caller: the era on its
 * presence record and the capture from the era store (authoritative), or the
 * record's own copy when the store has no entry.
 */
export function resolveTargetProvenance(root: string | null, sessionId: string): TargetProvenance {
  if (!root) return { era: null, capture: null };
  const record = readPresenceRecord(root, sessionId);
  const intel = record?.sessionIntel ?? null;
  if (!intel) return { era: null, capture: null };
  const entry = intel.era ? readEra(root, intel.era) : null;
  if (entry) {
    return { era: intel.era, capture: { captureKind: entry.captureKind, autoCompactWindowAtStart: entry.autoCompactWindowAtStart, capturedAt: entry.capturedAt } };
  }
  if (intel.capturedAt === null && intel.autoCompactWindowAtStart === null) return { era: intel.era, capture: null };
  return { era: intel.era, capture: { captureKind: intel.captureKind, autoCompactWindowAtStart: intel.autoCompactWindowAtStart, capturedAt: intel.capturedAt } };
}

// ---------------------------------------------------------------------------
// Caller binding
// ---------------------------------------------------------------------------

export interface CallerBinding {
  readonly sessionId: string | null;
  /** True only when every binding rule holds: record exists, not ended, live non-null era equal to the record's. */
  readonly bound: boolean;
  readonly era: string | null;
  readonly check: ProcessCheck;
  readonly reason: string;
}

export function resolveCallerBinding(root: string | null, explicitTaskId?: string | null, resolver: ProcessEraResolver = processEra): CallerBinding {
  if (currentStorybloqClient() !== "claude") return { sessionId: null, bound: false, era: null, check: "unverifiable", reason: "client is not Claude" };
  const sessionId = currentClientTaskId(explicitTaskId);
  if (!sessionId) return { sessionId: null, bound: false, era: null, check: "unverifiable", reason: "no caller session id" };
  const era = resolver.current();
  if (!root) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "no project" };
  const record = readPresenceRecord(root, sessionId);
  if (!record) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "no presence record for the caller" };
  if (record.endedAt !== null) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "caller session has ended" };
  if (!era) return { sessionId, bound: false, era: null, check: "unverifiable", reason: "process era unknown" };
  const check = resolver.revalidate();
  if (check !== "live") return { sessionId, bound: false, era: era.id, check, reason: `process era ${check}` };
  if (record.sessionIntel?.era !== era.id) return { sessionId, bound: false, era: era.id, check, reason: "record era differs from the live process era" };
  return { sessionId, bound: true, era: era.id, check, reason: "bound" };
}

// ---------------------------------------------------------------------------
// Pending compaction events
// ---------------------------------------------------------------------------

export const PENDING_SUBDIR = "session-intel-pending";
export const PENDING_MAX_LISTED = 32;
export const PENDING_TMP_STALE_MS = 60_000;
const PENDING_MAX_BYTES = 4096;

export interface PendingEvent {
  readonly eventId: string;
  readonly era: string | null;
  readonly at: string;
}

function pendingDirFor(root: string, sessionId: string, create: boolean): string | null {
  const base = create ? ensureTelemetrySubdir(root, PENDING_SUBDIR) : telemetrySubdirIfPresent(root, PENDING_SUBDIR);
  if (!base) return null;
  const dir = join(base, presenceFileBase(sessionId));
  if (directoryIdentity(dir) === null) {
    if (!create) return null;
    try { fs.mkdirSync(dir); } catch { /* identity check decides */ }
    if (directoryIdentity(dir) === null) return null;
  }
  return dir;
}

/**
 * Publishes an immutable pending file atomically: write + fsync to a `.tmp`
 * name, `link` to the final name (no replace; EEXIST with identical content
 * is success), unlink the tmp. Readers never open `.tmp` names.
 */
export function markCompactPending(root: string, sessionId: string, event: PendingEvent): boolean {
  const dir = pendingDirFor(root, sessionId, true);
  if (!dir) return false;
  const safeId = event.eventId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const final = join(dir, `${event.at.replace(/[^0-9TZ.:-]/g, "")}-${safeId}.json`);
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const text = JSON.stringify(event) + "\n";
  const identity = directoryIdentity(dir);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, text, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, final);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      return readBoundedNoFollow(final, PENDING_MAX_BYTES) === text;
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    removeRegularFile(dir, tmp, identity);
  }
}

export interface PendingListing {
  readonly complete: boolean;
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string; readonly event: PendingEvent | null; readonly mtimeMs: number }>;
}

const EMPTY_LISTING: PendingListing = { complete: true, files: [] };

/**
 * Lists the pending directory. `sweepTmp` removes stale `.tmp-*` leftovers
 * (locked callers only); a peek never mutates anything.
 */
function listPending(dir: string, now: number, identity: { dev: number; ino: number }, sweepTmp: boolean): PendingListing {
  let names: string[];
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
    for (const e of dirents) {
      if (!sweepTmp || !e.name.startsWith(".tmp-")) continue;
      try {
        const st = fs.lstatSync(join(dir, e.name));
        if (st.isFile() && now - st.mtimeMs > PENDING_TMP_STALE_MS) removeRegularFile(dir, join(dir, e.name), identity);
      } catch { /* gone */ }
    }
    names = dirents.filter((e) => e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch {
    return { complete: false, files: [] };
  }
  const complete = names.length <= PENDING_MAX_LISTED;
  const files = names.slice(0, PENDING_MAX_LISTED).map((name) => {
    const path = join(dir, name);
    let mtimeMs = now;
    try { mtimeMs = fs.lstatSync(path).mtimeMs; } catch { /* keep now */ }
    const text = readBoundedNoFollow(path, PENDING_MAX_BYTES);
    let event: PendingEvent | null = null;
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        if (raw && typeof raw.at === "string" && Number.isFinite(Date.parse(raw.at)) && typeof raw.eventId === "string") {
          event = { eventId: raw.eventId, era: typeof raw.era === "string" ? raw.era : null, at: raw.at };
        }
      } catch { /* unparsable */ }
    }
    return { name, path, event, mtimeMs };
  });
  return { complete, files };
}

interface ResolvedPending {
  readonly dir: string | null;
  readonly identity: { dev: number; ino: number } | null;
  readonly listing: PendingListing;
}

/**
 * Resolves the pending directory AND lists it in one step. Locked callers
 * call this INSIDE the lock so a directory created (and an event published)
 * while the lock was awaited is seen; a cached "absent" from before the
 * lock is never trusted.
 */
function resolvePending(root: string, sessionId: string, now: number, sweepTmp: boolean): ResolvedPending {
  const dir = pendingDirFor(root, sessionId, false);
  const identity = dir ? directoryIdentity(dir) : null;
  return { dir, identity, listing: dir && identity ? listPending(dir, now, identity, sweepTmp) : EMPTY_LISTING };
}

/** Non-mutating view of the pending set, for read-only computation. */
export function peekPending(root: string, sessionId: string, now: number): PendingListing {
  return resolvePending(root, sessionId, now, false).listing;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type Reconciliation = "complete" | "incomplete";

export interface ReconcileInput {
  readonly root: string;
  readonly sessionId: string;
  readonly cfg: SessionIntelConfig;
  /** Boundaries the entry point's own tail scan saw (ascending). */
  readonly tailBoundaries: readonly TranscriptBoundary[];
  /** Authorized transcript path for the backward scan, if any. */
  readonly transcriptPath: string | null;
  readonly source: "compact" | "other";
  readonly now: number;
}

const tsOf = (iso: string) => Date.parse(iso);

/** Applies a boundary newer than `lastBoundaryAt`. Idempotent. Pure. */
export function applyBoundaryReset(intel: SessionIntelPresence, ts: string): SessionIntelPresence {
  if (intel.lastBoundaryAt !== null && tsOf(ts) <= tsOf(intel.lastBoundaryAt)) return intel;
  const handoverAfter = intel.handoverWrittenAt !== null && tsOf(intel.handoverWrittenAt) >= tsOf(ts);
  return {
    ...intel,
    lastBoundaryAt: ts,
    epoch: { kind: "observed", at: ts },
    revision: intel.revision + 1,
    lastSample: null,
    handoverWrittenAt: handoverAfter ? intel.handoverWrittenAt : null,
    tokensAtHandover: handoverAfter ? intel.tokensAtHandover : null,
    handoverBoundaryAt: handoverAfter ? ts : null,
  };
}

/** An expired pending with its boundary out of reach: assumed identity, everything from before it cleared. */
export function applyAssumedReset(intel: SessionIntelPresence, at: string): SessionIntelPresence {
  if (intel.lastBoundaryAt !== null && tsOf(at) <= tsOf(intel.lastBoundaryAt)) return intel;
  return {
    ...intel,
    lastBoundaryAt: at,
    epoch: { kind: "assumed", at },
    revision: intel.revision + 1,
    lastSample: null,
    handoverWrittenAt: null,
    tokensAtHandover: null,
    handoverBoundaryAt: null,
  };
}

/**
 * The reconciliation steps, pure over an already-listed pending set and an
 * already-found newest boundary. Returns the reconciled subtree, the files
 * to unlink AFTER the record is written, and whether anything remains.
 *
 * Era isolation: a pending event may block or reset the record only when
 * its era is non-null and equals the record's era. A null-era or foreign-era
 * file (an earlier process of a resumed session, an install without
 * CLAUDE_PID) is stale cleanup: unlinked, never counted, never applied.
 */
export function reconcileIntel(
  intel: SessionIntelPresence,
  newestBoundary: TranscriptBoundary | null,
  listing: PendingListing,
  cfg: SessionIntelConfig,
  now: number,
): { intel: SessionIntelPresence; unlink: string[]; remaining: number; status: Reconciliation } {
  let next = intel;
  if (newestBoundary) next = applyBoundaryReset(next, newestBoundary.timestamp);
  const unlink: string[] = [];
  let remaining = 0;
  for (const f of listing.files) {
    if (f.event === null) {
      // Unparsable: pending while young, unlinked once past the TTL.
      if (now - f.mtimeMs > cfg.compactPendingTtlMs) unlink.push(f.path);
      else remaining++;
      continue;
    }
    if (f.event.era === null || intel.era === null || f.event.era !== intel.era) {
      unlink.push(f.path); // foreign or unattributed: cannot describe this era
      continue;
    }
    if (next.lastBoundaryAt !== null && tsOf(f.event.at) <= tsOf(next.lastBoundaryAt)) {
      unlink.push(f.path); // resolved by a boundary at or after it
      continue;
    }
    if (now - tsOf(f.event.at) > cfg.compactPendingTtlMs) {
      next = applyAssumedReset(next, f.event.at);
      unlink.push(f.path);
      continue;
    }
    remaining++;
  }
  const status: Reconciliation = listing.complete && remaining === 0 ? "complete" : "incomplete";
  return { intel: next, unlink, remaining, status };
}

export interface ReconcileOutcome {
  readonly status: Reconciliation;
  readonly enrichment: EnrichmentOutcome | null;
  readonly reason: string | null;
}

/**
 * Runs reconciliation under the presence lock. `budgetMs` is TRY (0) for
 * samplers and bounded-blocking for lifecycle hooks. Busy lock = incomplete.
 * The pending directory is RESOLVED AND LISTED INSIDE the lock (a PreCompact
 * that created the directory and published while the lock was awaited is
 * seen); the unlocked peek only decides the backward scan, which reads the
 * transcript alone. The record is written FIRST; resolved and expired files
 * are unlinked only after the write.
 */
export function reconcileUnderLock(input: ReconcileInput, budgetMs: number): ReconcileOutcome {
  const peek = peekPending(input.root, input.sessionId, input.now);

  let newest: TranscriptBoundary | null = input.tailBoundaries.length ? input.tailBoundaries[input.tailBoundaries.length - 1]! : null;
  if (newest === null && input.transcriptPath && (peek.files.length > 0 || input.source === "compact")) {
    const back = scanBackwardForBoundary({ path: input.transcriptPath, sessionId: input.sessionId, era: null, revisionSeen: null, epochSince: null });
    if (back?.boundary) newest = back.boundary;
  }

  let unlink: string[] = [];
  let status: Reconciliation = "incomplete";
  let locked: ResolvedPending = { dir: null, identity: null, listing: EMPTY_LISTING };
  const enrichment = applyPresenceEnrichment(input.root, input.sessionId, budgetMs, "session-intel", (base) => {
    const current = base.sessionIntel ?? emptySessionIntel();
    locked = resolvePending(input.root, input.sessionId, input.now, true);
    const r = reconcileIntel(current, newest, locked.listing, input.cfg, input.now);
    unlink = r.unlink;
    status = r.status;
    return r.intel !== current ? { ...base, sessionIntel: r.intel } : base;
  }, () => new Date(input.now));

  if (enrichment.status !== "written") {
    return { status: "incomplete", enrichment, reason: `presence write ${enrichment.status}` };
  }
  if (locked.dir && locked.identity) for (const path of unlink) removeRegularFile(locked.dir, path, locked.identity);
  return { status, enrichment, reason: status === "incomplete" ? "pending compaction events remain" : null };
}

// ---------------------------------------------------------------------------
// Persistence rule
// ---------------------------------------------------------------------------

export type PersistOutcome =
  | { readonly status: "accepted"; readonly intel: SessionIntelPresence }
  | { readonly status: "rejected"; readonly reason: string }
  /**
   * Not persisted. `validated` is true only when the locked checks RAN and
   * passed (the write itself failed afterwards): the evidence stands. False
   * means the lock was never acquired: nothing about the sample is proven.
   */
  | { readonly status: "skipped"; readonly reason: string; readonly validated: boolean };

export interface PersistInput {
  readonly root: string;
  readonly sessionId: string;
  readonly sample: TokenPressureSample;
  readonly transcriptPath: string;
  readonly cfg: SessionIntelConfig;
  readonly now: number;
  /** Recomputes suppression against the record as it is under the lock. */
  readonly recompute: (record: SessionIntelPresence) => TokenPressureSample;
}

/** The compact form kept on the record. */
export function compactSample(s: TokenPressureSample): SessionIntelSample {
  return {
    sampledAt: s.sampledAt,
    sampledBy: s.sampledBy,
    state: s.state,
    rawState: s.rawState,
    pct: s.pct,
    contextTokens: s.contextTokens,
    ceiling: s.ceiling.ceiling,
    ceilingSource: s.ceiling.source,
    ceilingConfidence: s.ceiling.confidence,
    observation: s.observation,
    imperativeSince: s.imperativeSince,
    suppressedBy: s.suppressedBy,
  };
}

/** Pure acceptance decision given the record and the current file identity. Exported for tests. */
export function judgeSample(
  intel: SessionIntelPresence,
  sample: TokenPressureSample,
  file: { incarnation: string | null; size: number | null; baselineOk: boolean; incomingOk: boolean },
): { verdict: "accept" | "reject"; reason: string; bumpRevision: boolean } {
  const obs = sample.observation;
  if (obs.era === null || intel.era === null || obs.era !== intel.era) return { verdict: "reject", reason: "era mismatch or null", bumpRevision: false };
  if (!obs.authoritative) return { verdict: "reject", reason: "non-authoritative scan", bumpRevision: false };
  if (obs.revisionSeen !== intel.revision) return { verdict: "reject", reason: `stale revision ${obs.revisionSeen} (record ${intel.revision})`, bumpRevision: false };
  if (file.incarnation === null || file.size === null) return { verdict: "reject", reason: "transcript unreadable at persist", bumpRevision: false };
  if (obs.incarnation !== file.incarnation) return { verdict: "reject", reason: "transcript incarnation replaced", bumpRevision: false };
  // BASELINE: has the file been truncated or rewritten since the record's own anchor?
  if (intel.incarnation === file.incarnation && (file.size < intel.consumedOffset || !file.baselineOk)) {
    return { verdict: "reject", reason: "baseline anchor broken (truncated or rewritten)", bumpRevision: true };
  }
  // INCOMING: does the observation still describe the file?
  if (file.size < obs.consumedOffset || file.size < obs.sizeAtOpen || !file.incomingOk) {
    return { verdict: "reject", reason: "observation anchor broken since read", bumpRevision: true };
  }
  if (intel.incarnation === file.incarnation && obs.consumedOffset < intel.consumedOffset) {
    return { verdict: "reject", reason: "older by byte offset", bumpRevision: false };
  }
  return { verdict: "accept", reason: "accepted", bumpRevision: false };
}

export function persistSample(input: PersistInput): PersistOutcome {
  // Boxed so the closure's assignment is visible to the narrowing below.
  const box: { outcome: PersistOutcome } = { outcome: { status: "skipped", reason: "not attempted", validated: false } };
  const enrichment = applyPresenceEnrichment(input.root, input.sessionId, TRY_LOCK_BUDGET_MS, "session-intel", (base) => {
    const intel = base.sessionIntel ?? emptySessionIntel();
    const obs = input.sample.observation;
    // Binding revalidated against the LOCKED record: an ended session never persists.
    if (base.endedAt !== null) {
      box.outcome = { status: "rejected", reason: "caller session has ended" };
      return base;
    }
    // A compaction that became pending since reconciliation (or one that
    // reconciliation has not applied) means the sample may predate it. The
    // directory is resolved HERE, under the lock: it may not have existed
    // when this call began.
    const pending = resolvePending(input.root, input.sessionId, input.now, false).listing;
    const pend = reconcileIntel(intel, null, pending, input.cfg, input.now);
    if (!pending.complete || pend.remaining > 0 || pend.intel !== intel) {
      box.outcome = { status: "rejected", reason: "compaction pending: reconciliation required" };
      return base;
    }
    // Both anchors through ONE descriptor, then the pathname re-checked.
    const wantBaseline = intel.baselineAnchor !== null;
    const check = anchorsStillMatch(input.transcriptPath, wantBaseline ? [obs.anchor, intel.baselineAnchor!] : [obs.anchor]);
    const baseline = wantBaseline && intel.incarnation === check.incarnation ? check.ok[1]! : true;
    const judged = judgeSample(intel, input.sample, { incarnation: check.incarnation, size: check.size, baselineOk: baseline, incomingOk: check.ok[0]! && check.pathStillIdentifies });
    if (judged.verdict === "reject") {
      box.outcome = { status: "rejected", reason: judged.reason };
      if (!judged.bumpRevision) return base;
      return { ...base, sessionIntel: { ...intel, revision: intel.revision + 1, consumedOffset: 0, baselineAnchor: null, incarnation: check.incarnation, lastSample: null } };
    }
    // Suppression recomputed against the record as it is NOW (a handover
    // stamp that landed between compute and persist is honoured). The epoch
    // is owned by reconciliation, never by a sample.
    const recomputed = input.recompute(intel);
    const next: SessionIntelPresence = {
      ...intel,
      transcriptPath: input.transcriptPath,
      consumedOffset: obs.consumedOffset,
      incarnation: obs.incarnation,
      baselineAnchor: obs.anchor,
      lastSample: compactSample(recomputed),
    };
    box.outcome = { status: "accepted", intel: next };
    return { ...base, sessionIntel: next };
  }, () => new Date(input.now));
  if (enrichment.status !== "written") {
    if (box.outcome.status === "rejected") return box.outcome;
    // "accepted" here means the checks passed and only the write failed.
    return { status: "skipped", reason: `presence write ${enrichment.status}`, validated: box.outcome.status === "accepted" };
  }
  return box.outcome;
}

// ---------------------------------------------------------------------------
// Handover stamp
// ---------------------------------------------------------------------------

export type HandoverStampOutcome = EnrichmentOutcome | { readonly status: "refused"; readonly reason: string };

/**
 * Stamps a handover on the CALLER's record under the binding rule,
 * revalidated against the locked record: the session must not have ended
 * and its era must be the caller's live (non-null) era. Never creates a
 * subtree for an unbound record.
 */
export function stampHandover(root: string, sessionId: string, expectedEra: string | null, tokensAtHandover: number | null, now: number): HandoverStampOutcome {
  let refused: string | null = null;
  const outcome = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base, nowIso) => {
    const intel = base.sessionIntel;
    if (expectedEra === null || !intel || intel.era === null || intel.era !== expectedEra) { refused = "record era differs from the caller's live era"; return base; }
    if (base.endedAt !== null) { refused = "caller session has ended"; return base; }
    return {
      ...base,
      sessionIntel: {
        ...intel,
        handoverWrittenAt: nowIso,
        tokensAtHandover: tokensAtHandover ?? intel.lastSample?.contextTokens ?? null,
        handoverBoundaryAt: intel.lastBoundaryAt,
      },
    };
  }, () => new Date(now));
  return refused !== null && outcome.status === "written" ? { status: "refused", reason: refused } : outcome;
}

/** Whether a boundary timestamp lies inside an era entry's proven interval. */
export function boundaryInsideEra(entry: EraEntry | null, ts: string, now: number): boolean {
  if (!entry) return false;
  const t = tsOf(ts);
  const start = tsOf(entry.capturedAt);
  const end = entry.endedAt ? tsOf(entry.endedAt) : now;
  return Number.isFinite(t) && t >= start && t <= end;
}

export const UNOBSERVED: Epoch = { kind: "unobserved" };
