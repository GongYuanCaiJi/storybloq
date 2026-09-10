import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test seam: report the Nth presence write of a test as lock-busy without running its callback. */
const inject: { busyOnCall: number | null; calls: number } = { busyOnCall: null, calls: 0 };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    if (source === "session-intel") {
      inject.calls++;
      if (inject.busyOnCall === inject.calls) { inject.busyOnCall = null; return { status: "skipped-lock-busy" }; }
    }
    return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});
import { sampleSession } from "../../src/core/session-intel/query.js";
import { PENDING_SUBDIR, markCompactPending, readPresenceRecord, stampHandover } from "../../src/core/session-intel/presence-bridge.js";
import { presenceFileBase } from "../../src/presence/types.js";
import { readLedger } from "../../src/core/session-intel/boundary-ledger.js";
import { createEraIfAbsent } from "../../src/core/session-intel/era-store.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { emptySessionIntel } from "../../src/presence/session-intel-fields.js";
import { handleSessionIntel, formatSessionIntelMd } from "../../src/cli/commands/session-intel.js";
import { SID, assistantRecord, boundaryRecord, growingSession, makeWorktreePair, writeTranscript } from "./session-intel-fixtures.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

interface Fx { base: string; root: string; projects: string; userSettings: string }

function withFixture(fn: (f: Fx) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-query-")));
  try {
    const root = join(base, "proj");
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "config.json"), "{}\n"); // what project-root discovery looks for
    const projects = join(base, "home", ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    const userSettings = join(base, "home", ".claude", "settings.json");
    fn({ base, root, projects, userSettings });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

function bindCaller(root: string, window = 450_000): string {
  const era = processEra.current()!.id;
  const entry = { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: "startup" as const, autoCompactWindowAtStart: window, autoCompactWindowSource: "user" as const, capturedAt: at(-30), endedAt: null, lastVerifiedAt: at(-30), unverifiableStreak: 0, sessionIds: [SID] };
  expect(createEraIfAbsent(root, entry)).toBe("created");
  applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, captureKind: "startup", autoCompactWindowAtStart: window, capturedAt: at(-30) } }));
  return era;
}

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");

describe("sampleSession", () => {
  it("bound caller: measures 266,711 against the captured setting, persists, and stamps boundaries inside the era", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      const lines = [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), input: 2, creation: 0, read: 266_709 })];
      writeTranscript(f.projects, encoded(f.root), SID, lines);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.binding).toBe("bound");
      expect(r.pressure?.contextTokens).toBe(266_711);
      expect(r.pressure?.ceiling).toMatchObject({ source: "setting", confidence: "high", ceiling: 0.925 * 450_000 });
      expect(r.pressure?.pct).toBeCloseTo(266_711 / 416_250, 4);
      expect(r.pressure?.state).toBe("ok");
      expect(r.usable).toBe(true);
      expect(r.presence).toBe("persisted");
      const intel = readPresenceRecord(f.root, SID)!.sessionIntel!;
      expect(intel.lastSample?.contextTokens).toBe(266_711);
      expect(intel.lastBoundaryAt).toBe(at(1));
      expect(intel.transcriptPath).toMatch(new RegExp(`${SID}\\.jsonl$`));
      const ledger = readLedger(f.root);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ sessionId: SID, era, captureKind: "startup", autoCompactWindowAtStart: 450_000, preTokens: 417_000 });
      // Second call: the ledger now measures the session.
      const r2 = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(r2.pressure?.ceiling.source).toBe("measured-session");
      expect(r2.pressure?.ceiling.ceiling).toBe(417_000);
    });
  });

  it("a boundary outside the era's proven interval is recorded unclassified and never measured", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(-60), pre: 300_000 }), assistantRecord({ ts: at(0), read: 10 })]);
      sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 });
      expect(readLedger(f.root)[0]).toMatchObject({ era: null, captureKind: null, autoCompactWindowAtStart: null });
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 });
      expect(r.pressure?.ceiling.source).toBe("setting");
    });
  });

  it("explicit --session-id is read-only: same ceiling as the bound query, nothing persisted, nothing ingested", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 100_000 })]);
      const ro = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", sessionId: SID, projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(ro.binding).toBe("read-only");
      expect(ro.presence).toBe("skipped");
      expect(readLedger(f.root)).toEqual([]);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      const bound = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(ro.pressure?.ceiling.ceiling).toBe(bound.pressure?.ceiling.ceiling);
      expect(ro.pressure?.ceiling.source).toBe("setting");
    });
  });

  it("no project: transcript-only, read-only, live setting read with its basis; absent setting falls to model evidence", () => {
    withFixture((f) => {
      const cwd = join(f.base, "nostory");
      mkdirSync(cwd);
      writeTranscript(f.projects, encoded(cwd), SID, [assistantRecord({ ts: at(0), read: 50_000 })]);
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 400_000 }));
      const r = sampleSession({ root: null, cwd, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r).toMatchObject({ binding: "read-only", presence: "no-project", usable: true });
      expect(r.pressure?.ceiling).toMatchObject({ source: "setting", confidence: "medium", ceiling: 0.925 * 400_000 });
      expect(r.pressure?.ceiling.basis).toMatch(/live read, no capture/);
      rmSync(f.userSettings);
      const m = sampleSession({ root: null, cwd, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(m.pressure?.ceiling).toMatchObject({ source: "model", conflict: "no model-window evidence" });
      expect(m.pressure?.state).toBe("advisory");
    });
  });

  it("codex client short-circuits to unknown before any file access; missing transcript is not_found", () => {
    withFixture((f) => {
      process.env.STORYBLOQ_CLIENT = "codex";
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects });
      expect(r).toMatchObject({ client: "codex", usable: false, pressure: null });
      delete process.env.STORYBLOQ_CLIENT;
      const nf = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects });
      expect(nf.unusableReason).toMatch(/not found/);
    });
  });

  it("unbound caller (no record) still answers read-only from the live setting, reported as unbound", () => {
    withFixture((f) => {
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 10 })]);
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.binding).toBe("read-only");
      expect(r.bindingReason).toMatch(/no presence record/);
      expect(r.pressure?.ceiling.basis).toMatch(/live read, unbound/);
      expect(r.presence).toBe("skipped");
    });
  });

  it("--caller-model mismatch is reported, never overridden; --full within budget is full and persists", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, growingSession(3000, 1_000, 100));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", callerModel: "claude-sonnet-5", projectsDir: f.projects, now: T0 });
      expect(r.callerModelMismatch).toEqual({ caller: "claude-sonnet-5", transcript: "claude-opus-5" });
      expect(r.pressure?.lastAssistantModel).toBe("claude-opus-5");
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", callerModel: "claude-opus-5", projectsDir: f.projects, now: T0 }).callerModelMismatch).toBeNull();
      const full = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", full: true, projectsDir: f.projects, now: T0 });
      expect(full.coverage).toBe("full");
      expect(full.session?.startedAt).toBe(at(0));
      expect(full.presence).toBe("persisted");
    });
  });

  it("--full over budget is partial, non-authoritative, never persists and never ingests", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), ...growingSession(3000, 1_000, 100)]);
      const partial = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", full: true, fullBudgetBytes: 64 * 1024, projectsDir: f.projects, now: T0 });
      expect(partial.coverage).toBe("partial");
      expect(partial.truncationReason).toMatch(/only the last/);
      expect(partial.pressure?.observation.authoritative).toBe(false);
      expect(partial.session?.startedAt).toBeNull();
      expect(partial.presence).toBe("skipped");
      expect(partial.presenceReason).toMatch(/partial scan never persists/);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      expect(readLedger(f.root)).toEqual([]);
    });
  });

  it("a pending compaction of the caller's era makes pressure unusable and persists nothing; null-era and foreign-era files neither block nor reset", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 10 })]);
      const dir = join(f.root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      markCompactPending(f.root, SID, { eventId: "n", era: null, at: at(1) });
      markCompactPending(f.root, SID, { eventId: "f", era: "7:7", at: at(-100) });
      const before = readPresenceRecord(f.root, SID)!.sessionIntel!;
      const ok = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 2 * 60_000 });
      expect(ok.usable).toBe(true);
      expect(ok.presence).toBe("persisted");
      expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
      const afterIntel = readPresenceRecord(f.root, SID)!.sessionIntel!;
      expect(afterIntel.revision).toBe(before.revision);
      expect(afterIntel.epoch).toEqual(before.epoch);
      markCompactPending(f.root, SID, { eventId: "e", era, at: at(3) });
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/pending/);
      expect(r.presence).toBe("skipped");
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toEqual(afterIntel.lastSample);
    });
  });

  it("read-only and bound queries agree after a new boundary: a pre-compaction handover suppresses neither, and nothing is written by the read-only one", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      const tokens = Math.ceil(0.85 * 416_250) - 25_000;
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: tokens })]);
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 }).pressure?.state).toBe("imperative");
      expect(stampHandover(f.root, SID, era, tokens, T0).status).toBe("written");
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 60_000 }).pressure).toMatchObject({ state: "advisory", suppressedBy: "handover" });
      // Compaction, then the context climbs back to the same level.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: tokens }), boundaryRecord({ ts: at(2), pre: tokens }), assistantRecord({ ts: at(3), read: tokens })]);
      const recordBefore = readPresenceRecord(f.root, SID)!;
      const ro = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", sessionId: SID, projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(ro.binding).toBe("read-only");
      expect(ro.pressure).toMatchObject({ state: "imperative", suppressedBy: null });
      expect(readPresenceRecord(f.root, SID)).toEqual(recordBefore);
      const bound = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(bound.pressure).toMatchObject({ state: "imperative", suppressedBy: null });
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastBoundaryAt).toBe(at(2));
    });
  });

  it("a lock-busy persist skip is unvalidated: not usable, nothing ingested; the next call persists and ingests", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 10 })]);
      // Call 1 is reconciliation (runs), call 2 is the persist (lock busy: none of its checks ran).
      inject.calls = 0;
      inject.busyOnCall = 2;
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.presence).toBe("skipped");
      expect(r.presenceReason).toMatch(/lock-busy/);
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/unvalidated/);
      expect(readLedger(f.root)).toEqual([]);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      inject.busyOnCall = null;
      const ok = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(ok.presence).toBe("persisted");
      expect(readLedger(f.root)).toHaveLength(1);
    });
  });

  it("a sample the persistence rule rejects is neither reported usable nor ingested into the ledger", () => {
    withFixture((f) => {
      bindCaller(f.root);
      const path = writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 10 })]);
      const st = statSync(path);
      // The record claims to have consumed far more of THIS incarnation than exists: baseline broken.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, incarnation: `${st.dev}:${st.ino}`, consumedOffset: st.size + 10_000, baselineAnchor: { offset: st.size + 10_000, sha256: "0".repeat(64) } } }));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.presence).toBe("rejected");
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/baseline/);
      expect(readLedger(f.root)).toEqual([]);
      // The detecting call bumped the revision; the next call is accepted and ingests.
      const next = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(next.presence).toBe("persisted");
      expect(next.usable).toBe(true);
      expect(readLedger(f.root)).toHaveLength(1);
    });
  });
});

describe("handleSessionIntel (the shared CLI/MCP handler)", () => {
  it("md and json carry the same numbers; json is an {ok, data} envelope; the CLI and MCP samplers agree; a nested cwd finds the project", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 266_709 })]);
      const cli = handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { ok: boolean; data: typeof cli.result };
      expect(parsed.ok).toBe(true);
      expect(cli.errorCode).toBeUndefined();
      expect(parsed.data.pressure?.contextTokens).toBe(266_711);
      expect(parsed.data.presence).toBe("persisted");
      const md = formatSessionIntelMd(cli.result);
      expect(md).toMatch(/Token pressure: OK/);
      expect(md).toMatch(/266,711 tokens \(64\.1% of the expected auto-compact point\)/);
      expect(md).toMatch(/source setting \(high confidence\)/);
      expect(md).toMatch(/Presence: persisted/);
      // The MCP surface uses the same handler with sampledBy mcp-refresh: identical numbers.
      const mcp = handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects, sampledBy: "mcp-refresh" });
      const m = JSON.parse(mcp.output) as { data: typeof cli.result };
      expect(m.data.pressure?.contextTokens).toBe(parsed.data.pressure?.contextTokens);
      expect(m.data.pressure?.ceiling).toEqual(parsed.data.pressure?.ceiling);
      expect(m.data.binding).toBe("bound");
      // From a subdirectory the project is still discovered (capture, ledger, record), the cwd is kept for lookup.
      const nested = join(f.root, "src", "deep");
      mkdirSync(nested, { recursive: true });
      writeTranscript(f.projects, encoded(nested), SID, [assistantRecord({ ts: at(0), read: 266_709 })]);
      const sub = handleSessionIntel({ cwd: nested, format: "json", projectsDir: f.projects });
      expect(sub.result.binding).toBe("bound");
      expect(sub.result.provenance.capture?.autoCompactWindowAtStart).toBe(450_000);
    });
  });

  it("no session identity, and a session id with no transcript, are not_found", () => {
    withFixture((f) => {
      process.env.CLAUDE_CODE_SESSION_ID = "no-such-session-0000";
      const cli = handleSessionIntel({ cwd: join(f.base, "nowhere"), format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { ok: boolean; data: { usable: boolean } };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.usable).toBe(false);
      expect(cli.errorCode).toBe("not_found");
      delete process.env.CLAUDE_CODE_SESSION_ID;
      expect(handleSessionIntel({ cwd: f.root, projectsDir: f.projects }).errorCode).toBe("not_found");
    });
  });
});

describe("ISS-1185: handleSessionIntel's worktree diagnostic", () => {
  function withWorktreeFixture(fn: (f: { base: string; main: string; worktree: string; projects: string }) => void): void {
    const wt = makeWorktreePair("si-query-wt-");
    try {
      for (const root of [wt.main, wt.worktree]) {
        mkdirSync(join(root, ".story"), { recursive: true });
        writeFileSync(join(root, ".story", "config.json"), "{}\n");
      }
      const projects = join(wt.base, "home", ".claude", "projects");
      mkdirSync(projects, { recursive: true });
      fn({ base: wt.base, main: wt.main, worktree: wt.worktree, projects });
    } finally {
      wt.cleanup();
    }
  }

  it("reports recordRoot (JSON and MD) only when the record lives under a different root than the one sampled; sampleSession's own binding decision is untouched (still unbound, still read-only)", () => {
    withWorktreeFixture((f) => {
      bindCaller(f.worktree);
      const cli = handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { data: { sessionId: string; binding: string; bindingReason: string; root: string; recordRoot: string | null } };
      // Regression (round-2 finding 1): sampleSession's own binding path is
      // strictly unaffected by the fallback -- unbound, exactly as before
      // this ticket, since query.ts passes no `walk` argument.
      expect(parsed.data.binding).toBe("read-only");
      expect(parsed.data.bindingReason).toMatch(/no presence record/);
      expect(parsed.data.root).toBe(f.main);
      expect(parsed.data.recordRoot).toBe(f.worktree);
      const md = handleSessionIntel({ cwd: f.main, format: "md", projectsDir: f.projects }).output;
      expect(md).toMatch(new RegExp(`Record found under a different root: ${f.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(sampled root: ${f.main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));

      // A record found directly under the sampled root: no diagnostic noise.
      bindCaller(f.main);
      const direct = JSON.parse(handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects }).output) as { data: { recordRoot: string | null } };
      expect(direct.data.recordRoot).toBeNull();
      expect(handleSessionIntel({ cwd: f.main, format: "md", projectsDir: f.projects }).output).not.toMatch(/Record found under a different root/);
    });
  });
});
