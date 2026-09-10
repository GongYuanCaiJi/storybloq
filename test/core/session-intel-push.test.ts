import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { ensureCapture } from "../../src/core/session-intel/capture.js";
import { applyBannerToMcpText, cliBannerFor, guideDirectiveFor, stampHandoverForCaller, tokenPressureBannerFor } from "../../src/core/session-intel/push.js";
import { markCompactPending, readPresenceRecord } from "../../src/core/session-intel/presence-bridge.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { handleStopHookSample } from "../../src/cli/commands/session-intel.js";
import { handleHandoverCreate } from "../../src/cli/commands/handover.js";
import { runMcpReadTool, runMcpWriteTool } from "../../src/mcp/tools.js";
import { runReadCommandWithRoot } from "../../src/cli/run.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS, type EnrichmentOutcome } from "../../src/core/presence-enrichment.js";
import type { SessionPresence } from "../../src/presence/types.js";
import { SID, assistantRecord, boundaryRecord, writeTranscript } from "./session-intel-fixtures.js";

/**
 * Test seam: a one-shot transform of the locked base record, standing in for
 * another writer (a sampler, a compaction hook) that landed between an
 * unlocked read and this write acquiring the lock.
 */
const inject: { transformBase: ((base: SessionPresence) => SessionPresence) | null; onCall: number; calls: number; forceOutcome: EnrichmentOutcome | null } = { transformBase: null, onCall: 1, calls: 0, forceOutcome: null };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    // A forced outcome stands in for a busy lock or a failed write on the next session-intel write: nothing is written.
    if (source !== "session-intel" || (!inject.forceOutcome && !inject.transformBase)) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    // Applied on the `onCall`-th session-intel write only (1 = the first).
    if (++inject.calls !== inject.onCall) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    if (inject.forceOutcome) { const o = inject.forceOutcome; inject.forceOutcome = null; return o; }
    const transform = inject.transformBase!;
    inject.transformBase = null;
    return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, (base, nowIso) => mutate(transform(base), nowIso), now);
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const CEILING = 0.925 * 450_000;
const ADVISORY_TOKENS = Math.ceil(0.7 * CEILING) + 1_000;
const IMPERATIVE_TOKENS = Math.ceil(0.85 * CEILING) - 25_000 + 1_000;

interface Fx { base: string; root: string; projects: string; userSettings: string }

async function makeFixture(): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-push-")));
  const root = join(base, "proj");
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "push" });
  const projects = join(base, "home", ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const userSettings = join(base, "home", ".claude", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
  return { base, root, projects, userSettings };
}

async function withFixture(fn: (f: Fx) => Promise<void> | void): Promise<void> {
  const f = await makeFixture();
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
  vi.restoreAllMocks();
});

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");
const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;

/** Binds the caller and persists one Stop-hook sample at `tokens`. */
function primed(f: Fx, tokens: number, now = T0 + 5 * 60_000): string {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
  writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: tokens - 2 })]);
  const r = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now, projectsDir: f.projects, userSettingsPath: f.userSettings });
  expect(r.result?.presence).toBe("persisted");
  return processEra.current()!.id;
}

const seams = (f: Fx) => ({ cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });

describe("tokenPressureBannerFor", () => {
  it("advisory and imperative produce a banner from a fresh stored sample; ok produces none; the sample must be the caller's own bound record", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull(); // no record yet
      primed(f, ADVISORY_TOKENS, now);
      const adv = tokenPressureBannerFor(f.root, { now, ...seams(f) });
      expect(adv).toMatchObject({ state: "advisory", ceilingSource: "setting", ceilingConfidence: "high", suppressedBy: null });
      expect(adv!.text).toMatch(/^Context pressure ADVISORY: 7[0-9]% of the expected auto-compact point/);
      expect(adv!.text).toMatch(/Plan a handover/);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(3), read: IMPERATIVE_TOKENS - 2 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const imp = tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) }, "cli");
      expect(imp?.state).toBe("imperative");
      expect(imp!.text).toMatch(/Write a handover now via storybloq handover create/);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(4), read: 10 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 2000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(tokenPressureBannerFor(f.root, { now: now + 2000, ...seams(f) })).toBeNull();
    });
  });

  it("binding rule: an ended id, an era mismatch, a null era, and a Codex client all push nothing; config and presence gates too", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })?.state).toBe("imperative");
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(5) }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null, sessionIntel: { ...b.sessionIntel!, era: "9:9" } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      const era = processEra.current()!.id;
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })?.state).toBe("imperative");
      delete process.env.CLAUDE_PID;
      processEra.reset();
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      process.env.CLAUDE_PID = String(process.pid);
      processEra.reset();
      process.env.STORYBLOQ_CLIENT = "codex";
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      delete process.env.STORYBLOQ_CLIENT;
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { banner: false } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ statusWriter: { presence: false } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
    });
  });

  it("a stale sample is refreshed by one bound tail sample that persists; a pending compaction or a blown budget yields nothing", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      const era = primed(f, IMPERATIVE_TOKENS, now);
      // A compaction APPENDS a boundary and a small post-compaction turn; the stored sample is 31 s old.
      const path = join(f.projects, encoded(f.root), `${SID}.jsonl`);
      appendFileSync(path, [boundaryRecord({ ts: at(6), pre: IMPERATIVE_TOKENS }), assistantRecord({ ts: at(7), read: 10 })].join("\n") + "\n");
      const later = now + 31_000;
      expect(tokenPressureBannerFor(f.root, { now: later, ...seams(f) })).toBeNull();
      expect(intelOf(f.root).lastSample?.sampledBy).toBe("mcp-refresh");
      expect(intelOf(f.root).lastSample?.state).toBe("ok");
      expect(intelOf(f.root).lastBoundaryAt).toBe(at(6));
      // Back up to imperative, fresh; then a pending event of this era blocks the banner.
      appendFileSync(path, assistantRecord({ ts: at(8), read: IMPERATIVE_TOKENS - 2 }) + "\n");
      const t2 = later + 60_000;
      expect(tokenPressureBannerFor(f.root, { now: t2, ...seams(f) })?.state).toBe("imperative");
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(t2 + 1000).toISOString() });
      expect(tokenPressureBannerFor(f.root, { now: t2 + 2000, ...seams(f) })).toBeNull();
      rmSync(join(f.root, ".story", "telemetry", "session-intel-pending"), { recursive: true });
      // Budget: a clock past the budget after binding produces nothing and persists nothing new.
      const before = intelOf(f.root).lastSample?.sampledAt;
      let calls = 0;
      expect(tokenPressureBannerFor(f.root, { now: t2 + 60_000, ...seams(f), clock: () => (++calls >= 2 ? 10_000 : 0) })).toBeNull();
      expect(intelOf(f.root).lastSample?.sampledAt).toBe(before);
    });
  });

  it("applyBannerToMcpText: md prefix, json sibling key on an object, any other json shape untouched", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, ADVISORY_TOKENS, now);
      const b = tokenPressureBannerFor(f.root, { now, ...seams(f) })!;
      expect(applyBannerToMcpText("body", "md", b)).toBe(`${b.text}\n\nbody`);
      const json = JSON.parse(applyBannerToMcpText(JSON.stringify({ version: 1, data: { x: 1 } }), "json", b)) as Record<string, unknown>;
      expect(json.data).toEqual({ x: 1 });
      expect(json.tokenPressure).toMatchObject({ state: "advisory", ceilingSource: "setting" });
      expect((json.tokenPressure as Record<string, unknown>).text).toBeUndefined();
      expect(applyBannerToMcpText("[1,2]", "json", b)).toBe("[1,2]");
      expect(applyBannerToMcpText("not json", "json", b)).toBe("not json");
      expect(applyBannerToMcpText("body", "md", null)).toBe("body");
    });
  });
});

describe("MCP and CLI pipelines", () => {
  it("runMcpReadTool prefixes md and adds the json sibling at advisory; never on isError; runMcpWriteTool prefixes md", async () => {
    await withFixture(async (f) => {
      primed(f, ADVISORY_TOKENS, Date.now());
      const md = await runMcpReadTool(f.root, () => ({ output: "hello" }));
      expect(md.content[0]!.text).toMatch(/^Context pressure ADVISORY:[\s\S]*\n\nhello$/);
      const json = await runMcpReadTool(f.root, () => ({ output: JSON.stringify({ version: 1, data: 1 }) }), undefined, "json");
      expect((JSON.parse(json.content[0]!.text) as Record<string, unknown>).tokenPressure).toMatchObject({ state: "advisory" });
      const err = await runMcpReadTool(f.root, () => ({ output: "boom", errorCode: "io_error" }));
      expect(err.isError).toBe(true);
      expect(err.content[0]!.text).not.toMatch(/Context pressure/);
      const write = await runMcpWriteTool(f.root, async () => ({ output: "written" }));
      expect(write.content[0]!.text).toMatch(/^Context pressure ADVISORY:[\s\S]*\n\nwritten$/);
      // ok: nothing.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(4), read: 10 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const quiet = await runMcpReadTool(f.root, () => ({ output: "hello" }));
      expect(quiet.content[0]!.text).toBe("hello");
    });
  });

  it("CLI: md appends the line to stdout; json emits one stderr line and leaves the stdout envelope untouched", async () => {
    await withFixture(async (f) => {
      primed(f, IMPERATIVE_TOKENS, Date.now());
      const cli = cliBannerFor(f.root, "json", seams(f));
      expect(cli.stdout).toBeNull();
      expect(cli.stderr).toMatch(/^\[storybloq\] Context pressure IMPERATIVE:.*storybloq handover create/);
      const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const errw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const origCwd = process.cwd();
      process.chdir(f.root);
      try {
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }));
        const stdout = out.mock.calls.map((c) => String(c[0])).join("");
        expect(stdout).toMatch(/^body\n\nContext pressure IMPERATIVE:/);
        out.mockClear();
        errw.mockClear();
        await runReadCommandWithRoot("json", f.root, () => ({ output: JSON.stringify({ version: 1, data: 1 }) }));
        expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe(JSON.stringify({ version: 1, data: 1 }) + "\n");
        expect(errw.mock.calls.map((c) => String(c[0])).join("")).toMatch(/^\[storybloq\] Context pressure IMPERATIVE:/);
      } finally {
        process.chdir(origCwd);
      }
    });
  });
});

describe("guide directive and handover stamp", () => {
  it("the directive appears only for an imperative, usable owner sample and only when enabled", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      const era = primed(f, ADVISORY_TOKENS, now);
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(3), read: IMPERATIVE_TOKENS - 2 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(guideDirectiveFor(f.root, SID, now + 1000)).toMatch(/^Context pressure imperative \([78][0-9]% of ceiling, source setting, high confidence\): write a handover now via storybloq_handover_create, then keep working in this same turn\./);
      expect(guideDirectiveFor(f.root, null, now + 1000)).toBeNull();
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(now + 2000).toISOString() });
      expect(guideDirectiveFor(f.root, SID, now + 3000)).toBeNull();
      rmSync(join(f.root, ".story", "telemetry", "session-intel-pending"), { recursive: true });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { guideDirective: false } }));
      expect(guideDirectiveFor(f.root, SID, now + 1000)).toBeNull();
    });
  });

  it("handover create stamps the bound caller's record against the current boundary and holds the next imperative sample at advisory; an unbound caller is untouched; stamp:false skips", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(intelOf(f.root).lastSample?.state).toBe("imperative");
      const r = await handleHandoverCreate("# Handover\nDone.", "session", "md", f.root, { now, projectsDir: f.projects });
      expect(r.output).toContain("Created handover:");
      // The reply itself tells the caller to keep working (the pause-after-handover field finding, 2026-09-09).
      expect(r.output).toMatch(/Keep working in this same turn; do not stop/);
      // Every reader drops to advisory at once, before any new sample lands.
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      const intel = intelOf(f.root);
      expect(intel.handoverWrittenAt).toBe(new Date(now).toISOString());
      expect(intel.tokensAtHandover).toBe(intel.lastSample?.contextTokens);
      expect(intel.handoverBoundaryAt).toBe(intel.lastBoundaryAt);
      // The next sample at the same level is held at advisory.
      const next = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(next.result?.pressure).toMatchObject({ state: "advisory", rawState: "imperative", suppressedBy: "handover" });
      expect(tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) })?.text).toMatch(/A recent handover holds this at advisory/);
      // Direct API: unbound caller (ended) is refused, stamp:false skips.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null }, endedAt: at(9) }));
      expect(stampHandoverForCaller(f.root, { now: now + 2000, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/ended/) });
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null }));
      const two = await handleHandoverCreate("# Two", "two", "md", f.root, { stamp: false, now: now + 3000 });
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
      // No stamp, no continuation line: the reply never claims a suppression that did not happen.
      expect(two.output).not.toMatch(/Keep working/);
      const asJson = await handleHandoverCreate("# Three", "three", "json", f.root, { now: now + 4000, projectsDir: f.projects });
      expect(JSON.parse(asJson.output as string).data).toMatchObject({ tokenPressureStamped: true });
    });
  });

  it("the continuation line and tokenPressureStamped ride only on a stamp whose locked write LANDED: busy lock, failed write, and a refusal under the lock all yield the bare reply and leave the record imperative", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      for (const forced of [{ status: "skipped-lock-busy" }, { status: "skipped-write-failed" }] as const) {
        // The stamp's reconcile is session-intel write 1; the stamp itself is write 2.
        inject.calls = 0;
        inject.onCall = 2;
        inject.forceOutcome = forced;
        const r = await handleHandoverCreate("# H", `h-${forced.status}`, "json", f.root, { now, projectsDir: f.projects });
        expect(inject.forceOutcome).toBeNull();
        expect(JSON.parse(r.output as string).data).toEqual({ filename: expect.any(String) });
        expect(r.output).not.toMatch(/Keep working/);
        expect(intelOf(f.root)).toMatchObject({ handoverWrittenAt: null, lastSample: { state: "imperative" } });
      }
      // Refused under the lock: the record's era changes between the binding check and the locked write.
      inject.calls = 0;
      inject.onCall = 2;
      inject.transformBase = (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era: "999:1" } });
      const md = await handleHandoverCreate("# H", "h-refused", "md", f.root, { now, projectsDir: f.projects });
      expect(inject.transformBase).toBeNull();
      expect(md.output).toMatch(/^Created handover: [^\n]+$/);
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
    });
  });

  it("a compaction and a new sample landing between the stamp's reconcile and its lock: the stamp pairs the NEW boundary with the NEW token count, never the old count", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      const old = intelOf(f.root);
      expect(old.lastBoundaryAt).toBeNull();
      // The other writer lands between the stamp's reconcile (session-intel
      // write 1) and the stamp itself (write 2): seen only inside the
      // stamp's lock, after any unlocked read would have happened.
      inject.calls = 0;
      inject.onCall = 2;
      inject.transformBase = (base) => ({
        ...base,
        sessionIntel: {
          ...base.sessionIntel!,
          lastBoundaryAt: at(6),
          epoch: { kind: "observed", at: at(6) },
          revision: base.sessionIntel!.revision + 1,
          lastSample: { ...base.sessionIntel!.lastSample!, contextTokens: 12_345, state: "ok", rawState: "ok", sampledAt: at(7) },
        },
      });
      const r = stampHandoverForCaller(f.root, { now: now + 2 * 60_000, projectsDir: f.projects });
      expect(r).toMatchObject({ status: "stamped", outcome: { status: "written" } });
      const intel = intelOf(f.root);
      expect(intel.handoverBoundaryAt).toBe(at(6));
      expect(intel.tokensAtHandover).toBe(12_345);
      expect(intel.tokensAtHandover).not.toBe(old.lastSample?.contextTokens);
    });
  });
});
