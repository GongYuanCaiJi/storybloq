import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCapture, publishCompactPending } from "../../src/core/session-intel/capture.js";
import { PENDING_SUBDIR, markCompactPending, readPresenceRecord } from "../../src/core/session-intel/presence-bridge.js";
import { readEra, markEraEnded, ERA_STORE_SUBDIR } from "../../src/core/session-intel/era-store.js";
import { ProcessEraResolver, processEra, type PsRunner } from "../../src/core/session-intel/process-era.js";
import { readLedger } from "../../src/core/session-intel/boundary-ledger.js";
import { readCoarseTokenPressureForSession, pctBucketOf } from "../../src/core/session-intel/status-projection.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { presenceFileBase } from "../../src/presence/types.js";
import { emptySessionIntel } from "../../src/presence/session-intel-fields.js";
import { handleSessionIntelStart, handleStopHookSample, handleSessionIntelPrompt, PROMPT_HOOK_EVENT_NAME } from "../../src/cli/commands/session-intel.js";
import { sampleSession } from "../../src/core/session-intel/query.js";
import { handleSessionCompactPrepare } from "../../src/cli/commands/session-compact.js";
import { buildActivePayload } from "../../src/autonomous/status-payload.js";
import { refreshStatusForSession } from "../../src/autonomous/status-writer.js";
import type { SessionState } from "../../src/autonomous/session-types.js";
import { SID, assistantRecord, boundaryRecord, contextOf, growingSession, writeTranscript } from "./session-intel-fixtures.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const SID2 = "5e00abbf-5dcb-4be3-90d3-2b13e0f50b30";

/** `ps -o lstart=` under LC_ALL=C TZ=UTC for 2026-09-09T12:15:15Z. */
const LSTART = "Wed Sep  9 12:15:15 2026";
/** Mutable so one resolver can succeed at `current()` and then fail or change at `revalidate()`. */
function fakePs(state: { table: Record<number, string | "gone">; fail?: boolean }): PsRunner {
  return (args) => {
    if (state.fail) return null;
    const row = state.table[Number(args[1])];
    return row === undefined || row === "gone" ? "" : row + "\n";
  };
}

interface Fx { base: string; root: string; projects: string; userSettings: string }

function makeFixture(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-life-")));
  const root = join(base, "proj");
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), "{}\n");
  const projects = join(base, "home", ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const userSettings = join(base, "home", ".claude", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
  return { base, root, projects, userSettings };
}

function withFixture(fn: (f: Fx) => void): void {
  const f = makeFixture();
  try { fn(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
}

async function withFixtureAsync(fn: (f: Fx) => Promise<void>): Promise<void> {
  const f = makeFixture();
  try { await fn(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
}

const saved = { ...process.env };
beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  process.env.CLAUDE_PID = String(process.pid);
  delete process.env.STORYBLOQ_CLIENT;
  processEra.reset();
});
afterEach(() => {
  for (const k of ["CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "STORYBLOQ_CLIENT"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  processEra.reset();
});

const intelOf = (root: string, sid = SID) => readPresenceRecord(root, sid)!.sessionIntel!;
const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");

describe("ensureCapture", () => {
  it("startup captures the setting as startup into the era store and the record; a second call is unchanged; compact never re-reads settings", () => {
    withFixture((f) => {
      const r = ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0, userSettingsPath: f.userSettings });
      expect(r).toMatchObject({ status: "captured", captureKind: "startup" });
      const era = processEra.current()!.id;
      expect(readEra(f.root, era)).toMatchObject({ captureKind: "startup", autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user", sessionIds: [SID], endedAt: null });
      expect(intelOf(f.root)).toMatchObject({ era, captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: at(0), revision: 0 });
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 + 1000, userSettingsPath: f.userSettings })).toEqual({ status: "unchanged", era });
      // The setting changes mid-process: a compact preserves the capture.
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 200_000 }));
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "compact", now: T0 + 2000, userSettingsPath: f.userSettings })).toEqual({ status: "unchanged", era });
      expect(intelOf(f.root).autoCompactWindowAtStart).toBe(450_000);
      expect(readEra(f.root, era)!.autoCompactWindowAtStart).toBe(450_000);
    });
  });

  it("clear transfers the era's entry onto the NEW session with its original kind (late stays late), whatever the old session's SessionEnd order", () => {
    withFixture((f) => {
      // An install that first met this process at a Stop hook: late.
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "stop", now: T0, userSettingsPath: f.userSettings })).toMatchObject({ status: "captured", captureKind: "late" });
      const era = processEra.current()!.id;
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 200_000 }));
      // Order A: the old session ended first.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(1) }));
      expect(ensureCapture({ root: f.root, sessionId: SID2, source: "clear", now: T0 + 60_000, userSettingsPath: f.userSettings })).toMatchObject({ status: "transferred", captureKind: "late" });
      expect(intelOf(f.root, SID2)).toMatchObject({ era, captureKind: "late", autoCompactWindowAtStart: 450_000, capturedAt: at(0) });
      expect(readEra(f.root, era)!.sessionIds).toEqual([SID, SID2]);
      // Order B: a third session cleared BEFORE the second ended: same result.
      const SID3 = "6f00abbf-5dcb-4be3-90d3-2b13e0f50b31";
      expect(ensureCapture({ root: f.root, sessionId: SID3, source: "clear", now: T0 + 120_000, userSettingsPath: f.userSettings })).toMatchObject({ status: "transferred", captureKind: "late" });
      expect(intelOf(f.root, SID3).capturedAt).toBe(at(0));
    });
  });

  it("a record whose era differs from the live era is re-captured from the store with a revision bump and a cleared subtree", () => {
    withFixture((f) => {
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0, userSettingsPath: f.userSettings });
      const era = processEra.current()!.id;
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era: "9:9", revision: 4, consumedOffset: 100, transcriptPath: "/x/y.jsonl", handoverWrittenAt: at(0) } }));
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "stop", now: T0 + 1000, userSettingsPath: f.userSettings })).toMatchObject({ status: "transferred", era });
      expect(intelOf(f.root)).toMatchObject({ era, revision: 5, consumedOffset: 0, handoverWrittenAt: null, transcriptPath: "/x/y.jsonl", captureKind: "startup" });
    });
  });

  it("both hook orders converge: presence hook first, or intel-start on a missing record, give the same capture", () => {
    withFixture((f) => {
      // Presence hook first (a record with no subtree), then intel-start.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "hook", (b) => b);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel).toBeNull();
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0, userSettingsPath: f.userSettings });
      const a = intelOf(f.root);
      // intel-start first on a missing record.
      ensureCapture({ root: f.root, sessionId: SID2, source: "startup", now: T0, userSettingsPath: f.userSettings });
      const b = intelOf(f.root, SID2);
      expect(a).toEqual(b);
      expect(a.revision).toBe(0);
    });
  });

  it("no process era: a late, era-less capture on the record only, never startup, nothing in the store; an unverifiable or ended era performs no side effect", async () => {
    await withFixtureAsync(async (f) => {
      delete process.env.CLAUDE_PID;
      processEra.reset();
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0, userSettingsPath: f.userSettings })).toEqual({ status: "late-unbound", captureKind: "late" });
      expect(intelOf(f.root)).toMatchObject({ era: null, captureKind: "late", autoCompactWindowAtStart: 450_000 });
      expect(existsSync(join(f.root, ".story", "telemetry", ERA_STORE_SUBDIR))).toBe(false);
      // Idempotent: the late capture is not re-read.
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 200_000 }));
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "stop", now: T0 + 1000, userSettingsPath: f.userSettings })).toEqual({ status: "late-unbound", captureKind: "late" });
      expect(intelOf(f.root).autoCompactWindowAtStart).toBe(450_000);
      // Unverifiable at revalidation: skipped, no record minted, the cached era kept.
      const ps = { table: { 11442: LSTART } as Record<number, string | "gone">, fail: false };
      const resolver = new ProcessEraResolver({ CLAUDE_PID: "11442" }, fakePs(ps), () => Date.now());
      expect(resolver.current()).not.toBeNull();
      ps.fail = true;
      expect(ensureCapture({ root: f.root, sessionId: SID2, source: "startup", now: T0, userSettingsPath: f.userSettings, resolver })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/unverifiable/) });
      expect(readPresenceRecord(f.root, SID2)).toBeNull();
      // A later live check resumes: captured now.
      ps.fail = false;
      await new Promise((r) => setTimeout(r, 0));
      const fresh = new ProcessEraResolver({ CLAUDE_PID: "11442" }, fakePs(ps));
      expect(ensureCapture({ root: f.root, sessionId: SID2, source: "startup", now: T0, userSettingsPath: f.userSettings, resolver: fresh })).toMatchObject({ status: "captured" });
      // Ended (pid reuse: a different start time on the cached era): skipped.
      ps.table = { 11442: "Wed Sep  9 13:00:00 2026" };
      const reused = new ProcessEraResolver({ CLAUDE_PID: "11442" }, fakePs(ps));
      // current() reads the NEW start; simulate the cached era by resolving first with the old table.
      ps.table = { 11442: LSTART };
      expect(reused.current()!.id).toBe(fresh.current()!.id);
      ps.table = { 11442: "Wed Sep  9 13:00:00 2026" };
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "clear", now: T0, userSettingsPath: f.userSettings, resolver: reused })).toMatchObject({ status: "skipped", reason: "process era ended" });
    });
  });

  it("an absent setting is stored as absent explicitly; a closed era gains no sessions", () => {
    withFixture((f) => {
      rmSync(f.userSettings);
      expect(ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0, userSettingsPath: f.userSettings })).toMatchObject({ status: "captured", captureKind: "absent" });
      expect(intelOf(f.root)).toMatchObject({ captureKind: "absent", autoCompactWindowAtStart: null });
      const era = processEra.current()!.id;
      expect(markEraEnded(f.root, era, at(1))).toBe(true);
      expect(ensureCapture({ root: f.root, sessionId: SID2, source: "clear", now: T0, userSettingsPath: f.userSettings })).toMatchObject({ status: "skipped", reason: "era closed" });
      expect(readEra(f.root, era)!.sessionIds).toEqual([SID]);
    });
  });
});

describe("PreCompact pending mark", () => {
  it("compact-prepare publishes an era-stamped pending file for the caller's session even with no autonomous session; codex and disabled presence publish nothing", async () => {
    await withFixtureAsync(async (f) => {
      await handleSessionCompactPrepare({ client: "claude", clientTaskId: SID, cwd: f.root });
      const dir = join(f.root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const event = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8")) as { era: string | null };
      expect(event.era).toBe(processEra.current()!.id);
      await handleSessionCompactPrepare({ client: "codex", clientTaskId: "codex-thread", cwd: f.root });
      expect(existsSync(join(f.root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase("codex-thread")))).toBe(false);
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ statusWriter: { presence: false } }));
      expect(publishCompactPending(f.root, SID2, T0)).toBe(false);
    });
  });
});

function bindStartup(f: Fx): string {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
  return processEra.current()!.id;
}

describe("handleSessionIntelStart", () => {
  it("compact: preserves the capture and reconciles, finding a boundary beyond the tail by the backward scan and resolving the pending file", () => {
    withFixture((f) => {
      const era = bindStartup(f);
      const lines = [boundaryRecord({ ts: at(1), pre: 400_000 }), ...growingSession(3000, 1_000, 100, T0 + 2 * 60_000)];
      const path = writeTranscript(f.projects, encoded(f.root), SID, lines);
      markCompactPending(f.root, SID, { eventId: "p", era, at: at(0) });
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 200_000 }));
      const r = handleSessionIntelStart({ source: "compact", sessionId: SID, cwd: f.root, transcriptPath: path, now: T0 + 3 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(r.status).toBe("done");
      expect(r.capture).toEqual({ status: "unchanged", era });
      expect(r.reconcile?.status).toBe("complete");
      const intel = intelOf(f.root);
      expect(intel.lastBoundaryAt).toBe(at(1));
      expect(intel.epoch).toEqual({ kind: "observed", at: at(1) });
      expect(intel.autoCompactWindowAtStart).toBe(450_000);
      expect(readdirSync(join(f.root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID)))).toHaveLength(0);
    });
  });

  it("startup/resume/clear capture per source; codex, no session id, no project and unknown source are skipped", () => {
    withFixture((f) => {
      expect(handleSessionIntelStart({ source: "startup", sessionId: SID, cwd: f.root, userSettingsPath: f.userSettings }).capture).toMatchObject({ status: "captured", captureKind: "startup" });
      expect(handleSessionIntelStart({ source: "clear", sessionId: SID2, cwd: f.root, userSettingsPath: f.userSettings }).capture).toMatchObject({ status: "transferred", captureKind: "startup" });
      expect(handleSessionIntelStart({ source: "resume", sessionId: SID, cwd: f.root, userSettingsPath: f.userSettings }).capture).toMatchObject({ status: "unchanged" });
      expect(handleSessionIntelStart({ source: "startup", sessionId: SID, cwd: f.root, client: "codex" })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Claude/) });
      expect(handleSessionIntelStart({ source: "startup", sessionId: null, cwd: f.root })).toMatchObject({ status: "skipped", reason: "no session id" });
      expect(handleSessionIntelStart({ source: "startup", sessionId: SID, cwd: join(f.base, "nowhere") })).toMatchObject({ status: "skipped", reason: "no project" });
      expect(handleSessionIntelStart({ source: "weird", sessionId: SID, cwd: f.root })).toMatchObject({ status: "skipped" });
    });
  });
});

describe("handleStopHookSample", () => {
  it("late-captures on first contact, persists a lifecycle-bound sample from the payload's transcript path, and ingests boundaries", () => {
    withFixture((f) => {
      const path = writeTranscript(f.projects, "elsewhere", SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 100_000 })]);
      const r = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, transcriptPath: path, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(r.status).toBe("sampled");
      expect(r.capture).toMatchObject({ status: "captured", captureKind: "late" });
      expect(r.result?.binding).toBe("bound");
      expect(r.result?.transcriptPath).toBe(path);
      expect(r.result?.presence).toBe("persisted");
      expect(r.result?.pressure?.sampledBy).toBe("stop-hook");
      expect(r.result?.pressure?.ceiling).toMatchObject({ source: "setting", confidence: "medium" });
      expect(intelOf(f.root).lastSample?.contextTokens).toBe(contextOf({ read: 100_000 }));
      expect(intelOf(f.root).transcriptPath).toBe(path);
      expect(readLedger(f.root)).toHaveLength(1);
      // A payload path that fails the access contract (wrong basename) falls back to lookup.
      const bad = writeTranscript(f.projects, "elsewhere", SID2, [assistantRecord({ ts: at(3), read: 10 })]);
      const r2 = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, transcriptPath: bad, now: T0 + 6 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(r2.result?.transcriptPath).toBe(path); // the record's hint
    });
  });

  it("each budget checkpoint (after capture, after locate, after scan, before persist) abandons the work with nothing persisted or ingested", () => {
    withFixture((f) => {
      bindStartup(f);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 100_000 })]);
      const r = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: T0 + 5 * 60_000, softBudgetMs: -1, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/after capture/) });
      // A clock that crosses the budget on the k-th checkpoint read.
      const sampleWithClockCrossingAt = (k: number) => {
        let calls = 0;
        return sampleSession({ root: f.root, cwd: f.root, sampledBy: "stop-hook", explicitTaskId: SID, allowGlob: true, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings, budget: { startedAt: 0, softMs: 100, clock: () => (++calls >= k ? 1000 : 0) } });
      };
      const afterLocate = sampleWithClockCrossingAt(1);
      expect(afterLocate).toMatchObject({ usable: false, unusableReason: expect.stringMatching(/after locate/), pressure: null, presence: "skipped" });
      const afterScan = sampleWithClockCrossingAt(2);
      expect(afterScan).toMatchObject({ usable: false, unusableReason: expect.stringMatching(/after scan/), pressure: null });
      const beforePersist = sampleWithClockCrossingAt(3);
      expect(beforePersist.pressure?.contextTokens).toBe(contextOf({ read: 100_000 }));
      expect(beforePersist).toMatchObject({ usable: false, unusableReason: expect.stringMatching(/before persist/), presence: "skipped", presenceReason: expect.stringMatching(/before persist/) });
      expect(intelOf(f.root).lastSample).toBeNull();
      expect(readLedger(f.root)).toEqual([]);
      // With the budget never crossed the same call persists and ingests.
      expect(sampleWithClockCrossingAt(99).presence).toBe("persisted");
      expect(readLedger(f.root)).toHaveLength(1);
    });
  });

  it("no session id, disabled presence and disabled feature are skipped", () => {
    withFixture((f) => {
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: 100_000 })]);
      expect(handleStopHookSample({ root: f.root, sessionId: null, cwd: f.root })).toMatchObject({ status: "skipped", reason: "no session id" });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { enabled: false } }));
      expect(handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root })).toMatchObject({ status: "skipped", reason: "sessionIntel disabled" });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ statusWriter: { presence: false } }));
      expect(handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root })).toMatchObject({ status: "skipped", reason: "presence disabled" });
    });
  });
});

describe("status.json projection", () => {
  it("pctBucketOf floors to 5", () => {
    expect(pctBucketOf(0.638)).toBe(60);
    expect(pctBucketOf(0.65)).toBe(65);
    expect(pctBucketOf(1.106)).toBe(110);
    expect(pctBucketOf(null)).toBeNull();
    expect(pctBucketOf(-0.1)).toBe(0);
  });

  it("projects the OWNER's record coarsely, omits the field when nothing to project, reads unknown while a compaction is pending, and both writers agree", () => {
    withFixture((f) => {
      const era = bindStartup(f);
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID })).toBeNull();
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: null })).toBeNull();
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: 266_709 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const coarse = readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID }, T0 + 5 * 60_000);
      expect(coarse).toEqual({ state: "ok", pctBucket: 60, ceilingSource: "setting", ceilingConfidence: "high" });
      // The Stop hook's own session is not the owner: the projection follows the owner id.
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID2 })).toBeNull();
      // Both writers: buildActivePayload carries it only when given; the guide writer reads it through the same function.
      const state = { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", state: "IMPLEMENT", status: "active", claudeCodeSessionId: SID } as unknown as SessionState;
      expect("tokenPressure" in buildActivePayload(state, { tokenPressure: null })).toBe(false);
      expect(buildActivePayload(state, { tokenPressure: coarse }).tokenPressure).toEqual(coarse);
      const dir = join(f.root, ".story", "sessions", state.sessionId);
      mkdirSync(join(dir, "telemetry"), { recursive: true });
      expect(refreshStatusForSession(f.root, dir, state, "guide")).toBe(true);
      const written = JSON.parse(readFileSync(join(f.root, ".story", "status.json"), "utf-8")) as { tokenPressure?: unknown };
      expect(written.tokenPressure).toEqual(coarse);
      // A pending compaction of this era: unknown, bucket withheld, provenance kept.
      markCompactPending(f.root, SID, { eventId: "p", era, at: at(6) });
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID }, T0 + 7 * 60_000)).toEqual({ state: "unknown", pctBucket: null, ceilingSource: "setting", ceilingConfidence: "high" });
    });
  });

  it("an expired pending event of the record's era (assumed reset) never lets the pre-compaction sample resurface as usable", () => {
    withFixture((f) => {
      const era = bindStartup(f);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: 266_709 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID }, T0 + 5 * 60_000)?.state).toBe("ok");
      markCompactPending(f.root, SID, { eventId: "p", era, at: at(6) });
      // Past the TTL with no boundary in reach: reconciliation reports complete but has cleared the sample.
      expect(readCoarseTokenPressureForSession(f.root, { claudeCodeSessionId: SID }, T0 + 60 * 60_000)).toEqual({ state: "unknown", pctBucket: null, ceilingSource: "setting", ceilingConfidence: "high" });
    });
  });

  it("the era-less late capture answers the query at medium confidence and projects nothing bound: no ledger attribution, sample persisted read-only never", () => {
    withFixture((f) => {
      delete process.env.CLAUDE_PID;
      processEra.reset();
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 100_000 })]);
      const r = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(r.capture).toEqual({ status: "late-unbound", captureKind: "late" });
      expect(r.result?.binding).toBe("read-only");
      expect(r.result?.pressure?.ceiling).toMatchObject({ source: "setting", confidence: "medium" });
      expect(r.result?.presence).toBe("skipped");
      expect(readLedger(f.root)).toEqual([]);
      expect(intelOf(f.root).lastSample).toBeNull();
      expect(intelOf(f.root)).toMatchObject({ ...emptySessionIntel(), era: null, captureKind: "late", autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user", capturedAt: at(5) });
    });
  });
});

describe("handleSessionIntelPrompt (UserPromptSubmit)", () => {
  const CEILING = 0.925 * 450_000;
  const ADVISORY_TOKENS = Math.ceil(0.7 * CEILING) + 1_000;
  const IMPERATIVE_TOKENS = Math.ceil(0.85 * CEILING) - 25_000 + 1_000;
  const seams = (f: Fx) => ({ cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });

  it("emits additionalContext only at imperative from a usable sample; ok and advisory stay silent; the sample is persisted as prompt-hook", () => {
    withFixture((f) => {
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
      const path = writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: 100_000 })]);
      const ok = handleSessionIntelPrompt({ sessionId: SID, transcriptPath: path, now: T0 + 5 * 60_000, ...seams(f) });
      expect(ok).toMatchObject({ status: "silent", reason: "state ok", output: null });
      expect(ok.result?.presence).toBe("persisted");
      expect(intelOf(f.root).lastSample?.sampledBy).toBe("prompt-hook");

      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(3), read: ADVISORY_TOKENS - 2 })]);
      expect(handleSessionIntelPrompt({ sessionId: SID, now: T0 + 6 * 60_000, ...seams(f) })).toMatchObject({ status: "silent", reason: "state advisory", output: null });

      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(4), read: IMPERATIVE_TOKENS - 2 })]);
      const imp = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 7 * 60_000, ...seams(f) });
      expect(imp.status).toBe("emitted");
      const parsed = JSON.parse(imp.output!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(parsed).toEqual({ hookSpecificOutput: { hookEventName: PROMPT_HOOK_EVENT_NAME, additionalContext: expect.any(String) } });
      expect(PROMPT_HOOK_EVENT_NAME).toBe("UserPromptSubmit");
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(/^\[storybloq\] Context pressure IMPERATIVE: [78][0-9]% of the expected auto-compact point \([0-9,]+ tokens; source setting, high confidence\)\. Write a handover now via storybloq_handover_create/);
      expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    });
  });

  it("an imperative sample that is NOT usable (pending compaction of this era) emits nothing", async () => {
    await withFixtureAsync(async (f) => {
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: IMPERATIVE_TOKENS - 2 })]);
      expect(handleSessionIntelPrompt({ sessionId: SID, now: T0 + 5 * 60_000, ...seams(f) }).status).toBe("emitted");
      await publishCompactPending(f.root, SID, T0 + 5 * 60_000 + 500);
      const r = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 5 * 60_000 + 1000, ...seams(f) });
      expect(r.status).toBe("silent");
      expect(r.result?.usable).toBe(false);
      expect(r.output).toBeNull();
    });
  });

  it("never globs: a transcript reachable only by glob is not found, and the outcome is silent", () => {
    withFixture((f) => {
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
      writeTranscript(f.projects, "elsewhere", SID, [assistantRecord({ ts: at(2), read: IMPERATIVE_TOKENS - 2 })]);
      const r = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 5 * 60_000, ...seams(f) });
      expect(r.status).toBe("silent");
      expect(r.result?.transcriptPath).toBeNull();
      // The Stop hook, which may glob, finds it.
      expect(handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: T0 + 5 * 60_000, projectsDir: f.projects, userSettingsPath: f.userSettings }).result?.transcriptPath).not.toBeNull();
    });
  });

  it("an unbound caller never emits, even from a usable imperative sample: null era, ended record, era mismatch", () => {
    withFixture((f) => {
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: IMPERATIVE_TOKENS - 2 })]);
      expect(handleSessionIntelPrompt({ sessionId: SID, now: T0 + 5 * 60_000, ...seams(f) }).status).toBe("emitted");

      // Null era: the hook runs without CLAUDE_PID.
      delete process.env.CLAUDE_PID;
      processEra.reset();
      const nullEra = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 6 * 60_000, ...seams(f) });
      expect(nullEra.result?.binding).toBe("read-only");
      expect(nullEra.result?.pressure?.state).toBe("imperative");
      expect(nullEra).toMatchObject({ status: "silent", output: null });
      expect(nullEra.reason).toMatch(/^unbound caller: /);
      process.env.CLAUDE_PID = String(process.pid);
      processEra.reset();

      // Era mismatch: the record belongs to another process era. The hook's
      // own capture step re-binds it from the era store (revision bump,
      // cleared subtree) BEFORE sampling, so the emission comes from a record
      // whose era is the live one, never from the foreign-era record.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base) => ({ ...base, sessionIntel: { ...base.sessionIntel!, era: "1:1" } }));
      const revisionBefore = intelOf(f.root).revision;
      const mismatch = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 7 * 60_000, ...seams(f) });
      expect(mismatch.capture?.status).toBe("transferred"); // from the era store, original kind
      expect(intelOf(f.root).era).toBe(processEra.current()!.id);
      expect(intelOf(f.root).revision).toBe(revisionBefore + 1);
      expect(mismatch.result?.binding).toBe("bound");
      expect(mismatch.status).toBe("emitted");

      // Ended record.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base) => ({ ...base, endedAt: at(7) }));
      const ended = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 8 * 60_000, ...seams(f) });
      expect(ended.result?.binding).toBe("read-only");
      expect(ended).toMatchObject({ status: "silent", output: null });
    });
  });

  it("codex, no session id, no project, presence off, feature off, promptHook off, and a spent budget are skipped with no output", () => {
    withFixture((f) => {
      expect(handleSessionIntelPrompt({ client: "codex", sessionId: SID, ...seams(f) })).toMatchObject({ status: "skipped", reason: "client is not Claude", output: null });
      expect(handleSessionIntelPrompt({ sessionId: null, ...seams(f) })).toMatchObject({ status: "skipped", reason: "no session id" });
      expect(handleSessionIntelPrompt({ sessionId: SID, ...seams(f), cwd: join(f.base, "home") })).toMatchObject({ status: "skipped", reason: "no project" });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { promptHook: false } }));
      expect(handleSessionIntelPrompt({ sessionId: SID, ...seams(f) })).toMatchObject({ status: "skipped", reason: "promptHook disabled" });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { enabled: false } }));
      expect(handleSessionIntelPrompt({ sessionId: SID, ...seams(f) })).toMatchObject({ status: "skipped", reason: "sessionIntel disabled" });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ statusWriter: { presence: false } }));
      expect(handleSessionIntelPrompt({ sessionId: SID, ...seams(f) })).toMatchObject({ status: "skipped", reason: "presence disabled" });
      writeFileSync(join(f.root, ".story", "config.json"), "{}\n");
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: IMPERATIVE_TOKENS - 2 })]);
      const r = handleSessionIntelPrompt({ sessionId: SID, now: T0 + 5 * 60_000, softBudgetMs: -1, ...seams(f) });
      expect(r).toMatchObject({ status: "skipped", reason: "soft budget exceeded after capture", output: null });
      expect(readPresenceRecord(f.root, SID)?.sessionIntel?.lastSample ?? null).toBeNull();
    });
  });
});
