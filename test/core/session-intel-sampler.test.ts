import { describe, it, expect } from "vitest";
import { computeSample, handoverSuppresses, jumpAllowanceFor, p90, usageAdvisoryFrom } from "../../src/core/session-intel/sampler.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../src/presence/session-intel-fields.js";
import type { CeilingResolution, ScanResult, UsageAdvisoryInput } from "../../src/core/session-intel/types.js";

const cfg = resolveSessionIntelConfig(null);
const NOW = "2026-09-09T12:30:00.000Z";

function ceiling(over: Partial<CeilingResolution> = {}): CeilingResolution {
  return { ceiling: 417_737, source: "measured-session", confidence: "high", sampleCount: 5, independentSessions: 1, effectiveSampleWindow: 5, basis: "test", conflict: null, autoCompactWindowAtStart: 450_000, captureKind: "startup", nativeWindow: null, highWaterMark: null, ...over };
}

function scan(contextTokens: number | null, deltas: number[] = []): ScanResult {
  return {
    observation: { era: "1:2", incarnation: "1:1", sizeAtOpen: 10, consumedOffset: 10, anchor: { offset: 10, sha256: "a".repeat(64) }, authoritative: true, revisionSeen: 0, lastRecordTimestamp: NOW, epoch: { kind: "unobserved" } },
    coverage: "tail", scannedBytes: 10, truncationReason: null, contextTokens, lastAssistantAt: NOW, lastAssistantModel: "claude-opus-5", oneMillionFlag: null, modelEvidence: "none",
    boundaries: [], deltas, highWaterMark: contextTokens,
    session: { startedAt: null, version: null, entrypoint: null, cwd: null, gitBranch: null, permissionMode: null, aiTitle: null, slug: null, bridgeSessionId: null, effort: null, models: [], turns: null, compactions: { autoObserved: 0, manualObserved: 0, unknownObserved: 0, last: null } },
  };
}

const NO_USAGE: UsageAdvisoryInput = { window: null, source: null, provenance: "none" };

const sample = (tokens: number | null, over: { deltas?: number[]; record?: SessionIntelPresence | null; ceiling?: CeilingResolution; usage?: UsageAdvisoryInput } = {}) =>
  computeSample({ scan: scan(tokens, over.deltas ?? []), ceiling: over.ceiling ?? ceiling(), cfg, sampledBy: "query", sampledAt: NOW, record: over.record ?? null, usage: over.usage ?? NO_USAGE });

describe("computeSample states", () => {
  it("266,711 against 417,737 is 63.8%, ok", () => {
    const s = sample(266_711);
    expect(s.pct).toBeCloseTo(0.6385, 3);
    expect(s.state).toBe("ok");
    expect(s.headroom).toBe(417_737 - 266_711);
    expect(s.jumpAllowance).toBe(25_000);
    expect(s.jumpAllowanceBasis).toMatch(/floor 25000 \(0 deltas/);
  });

  it("advisory at 70%, imperative when tokens + jump allowance reach 85%", () => {
    expect(sample(Math.ceil(0.7 * 417_737)).state).toBe("advisory");
    expect(sample(Math.ceil(0.7 * 417_737) - 1).state).toBe("ok");
    const imperativeAt = Math.ceil(0.85 * 417_737) - 25_000;
    expect(sample(imperativeAt).state).toBe("imperative");
    expect(sample(imperativeAt - 1).state).toBe("advisory");
    expect(sample(imperativeAt).reason).toMatch(/\+ jump allowance 25000 >= 0.85/);
  });

  it("jump allowance is p90 of deltas since the epoch, clamped, floor under 5 deltas", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([])).toBeNull();
    expect(jumpAllowanceFor([1, 2, 3, 4], cfg)).toMatchObject({ value: 25_000 });
    expect(jumpAllowanceFor([30_000, 31_000, 32_000, 33_000, 34_000], cfg).value).toBe(34_000);
    expect(jumpAllowanceFor([1, 1, 1, 1, 1], cfg)).toMatchObject({ value: 25_000, basis: expect.stringMatching(/raised to floor/) });
    expect(jumpAllowanceFor([1e6, 1e6, 1e6, 1e6, 1e6], cfg)).toMatchObject({ value: 150_000, basis: expect.stringMatching(/capped/) });
    // A big p90 pulls imperative earlier.
    const tokens = Math.ceil(0.85 * 417_737) - 100_000;
    expect(sample(tokens).state).toBe("ok");
    expect(sample(tokens, { deltas: [90_000, 100_000, 100_000, 100_000, 100_000] }).state).toBe("imperative");
  });

  it("a ceiling conflict floors state at advisory even below 70%", () => {
    const s = sample(100_000, { ceiling: ceiling({ conflict: "high-water exceeds forecast" }) });
    expect(s.state).toBe("advisory");
    expect(s.reason).toMatch(/ceiling conflict/);
  });

  it("unknown when there is no usage record or no ceiling", () => {
    expect(sample(null)).toMatchObject({ state: "unknown", pct: null, reason: expect.stringMatching(/no assistant usage/) });
    expect(sample(100, { ceiling: ceiling({ ceiling: null, source: "unknown", confidence: null }) })).toMatchObject({ state: "unknown", reason: expect.stringMatching(/ceiling unknown/) });
  });
});

describe("handover suppression", () => {
  const imperativeTokens = Math.ceil(0.85 * 417_737) - 25_000;
  const withHandover = (over: Partial<SessionIntelPresence>): SessionIntelPresence => ({
    ...emptySessionIntel(),
    handoverWrittenAt: "2026-09-09T12:20:00.000Z",
    tokensAtHandover: imperativeTokens,
    handoverBoundaryAt: null,
    lastBoundaryAt: null,
    ...over,
  });

  it("suppresses imperative to advisory while the handover belongs to the current compaction and the context has not grown a step", () => {
    const s = sample(imperativeTokens, { record: withHandover({}) });
    expect(s).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
    expect(s.reason).toMatch(/suppressed by a handover/);
  });

  it("re-arms once tokens cross stepPct x ceiling past the handover", () => {
    const step = Math.ceil(0.05 * 417_737);
    expect(sample(imperativeTokens + step - 1, { record: withHandover({}) }).state).toBe("advisory");
    expect(sample(imperativeTokens + step, { record: withHandover({}) }).state).toBe("imperative");
  });

  it("a handover from a previous compaction does not suppress; one migrated to the current boundary does", () => {
    const stale = withHandover({ lastBoundaryAt: "2026-09-09T12:25:00.000Z", handoverBoundaryAt: null });
    expect(sample(imperativeTokens, { record: stale }).state).toBe("imperative");
    const migrated = withHandover({ lastBoundaryAt: "2026-09-09T12:25:00.000Z", handoverBoundaryAt: "2026-09-09T12:25:00.000Z" });
    expect(sample(imperativeTokens, { record: migrated }).state).toBe("advisory");
    expect(handoverSuppresses(null, 1, 1, cfg)).toBe(false);
    expect(handoverSuppresses(withHandover({ tokensAtHandover: null }), 1, 1, cfg)).toBe(false);
  });

  it("imperativeSince is carried from the record's last sample and cleared when not imperative; it never affects suppression", () => {
    const prior = withHandover({ lastSample: { ...sample(imperativeTokens), sampledAt: "2026-09-09T12:10:00.000Z", imperativeSince: "2026-09-09T12:10:00.000Z", observation: scan(1).observation, ceiling: 417_737, ceilingSource: "measured-session", ceilingConfidence: "high", state: "imperative", rawState: "imperative", pct: 0.8, contextTokens: imperativeTokens, suppressedBy: null } });
    const s = sample(imperativeTokens, { record: prior });
    expect(s.imperativeSince).toBe("2026-09-09T12:10:00.000Z");
    expect(s.state).toBe("advisory");
    expect(sample(imperativeTokens).imperativeSince).toBe(NOW);
    expect(sample(1000).imperativeSince).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-501: the usage-cost advisory, decided from the resolved inputs alone.
// ---------------------------------------------------------------------------

describe("usageAdvisoryFrom", () => {
  const input = (window: number | null, source: UsageAdvisoryInput["source"] = null): UsageAdvisoryInput =>
    ({ window, source, provenance: window === null ? "none" : "capture" });

  it("a window above the recommended max gives kind window with the observed value and its source", () => {
    expect(usageAdvisoryFrom(input(1_000_000, "user"), null, cfg)).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
  });

  it("a window at the recommended max gives nothing", () => {
    expect(usageAdvisoryFrom(input(450_000, "user"), null, cfg)).toBeNull();
    expect(usageAdvisoryFrom(input(450_001, "user"), null, cfg)).toEqual({ kind: "window", observed: 450_001, source: "user", recommendedMax: 450_000 });
  });

  it("no observed window plus a 1M model gives kind model", () => {
    expect(usageAdvisoryFrom(input(null), true, cfg)).toEqual({ kind: "model", nativeWindow: 1_000_000, recommendedMax: 450_000 });
  });

  it("a 1M model with a window at or under the max gives nothing (the window bounds it)", () => {
    expect(usageAdvisoryFrom(input(450_000, "user"), true, cfg)).toBeNull();
  });

  it("no observed window and no 1M evidence gives nothing", () => {
    expect(usageAdvisoryFrom(input(null), null, cfg)).toBeNull();
    expect(usageAdvisoryFrom(input(null), false, cfg)).toBeNull();
  });

  it("recommendedWindowMax 0 disables BOTH kinds", () => {
    const off = resolveSessionIntelConfig({ recommendedWindowMax: 0 });
    expect(off.recommendedWindowMax).toBe(0);
    expect(usageAdvisoryFrom(input(1_000_000, "user"), true, off)).toBeNull();
    expect(usageAdvisoryFrom(input(null), true, off)).toBeNull();
  });

  it("the max is a threshold, never a sentinel by magnitude: 2,000,000 against a max of 1,000,000 still fires", () => {
    const high = resolveSessionIntelConfig({ recommendedWindowMax: 1_000_000 });
    expect(usageAdvisoryFrom(input(2_000_000, "local"), null, high)).toEqual({ kind: "window", observed: 2_000_000, source: "local", recommendedMax: 1_000_000 });
  });

  it("a window with no known source keeps the advisory and reports source null", () => {
    expect(usageAdvisoryFrom(input(600_000), null, cfg)).toEqual({ kind: "window", observed: 600_000, source: null, recommendedMax: 450_000 });
  });
});

describe("computeSample carries the advisory on every path", () => {
  it("an ok sample still carries the advisory", () => {
    const s = sample(10, { usage: { window: 1_000_000, source: "user", provenance: "capture" } });
    expect(s.state).toBe("ok");
    expect(s.usageAdvisory).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
    expect(s.usageInput).toEqual({ window: 1_000_000, source: "user", provenance: "capture" });
  });

  it("an unknown sample (no context tokens) still carries the advisory and the input", () => {
    const s = sample(null, { usage: { window: 600_000, source: "project", provenance: "live" } });
    expect(s.state).toBe("unknown");
    expect(s.usageAdvisory).toEqual({ kind: "window", observed: 600_000, source: "project", recommendedMax: 450_000 });
  });

  it("an unknown-ceiling sample still carries the advisory", () => {
    const s = sample(100, { ceiling: ceiling({ ceiling: null }), usage: { window: 600_000, source: "user", provenance: "capture" } });
    expect(s.usageAdvisory).not.toBeNull();
  });

  it("the model kind reads oneMillionFlag from the scan", () => {
    const withFlag = computeSample({ scan: { ...scan(10), oneMillionFlag: true }, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: NOW, record: null, usage: NO_USAGE });
    expect(withFlag.usageAdvisory).toEqual({ kind: "model", nativeWindow: 1_000_000, recommendedMax: 450_000 });
  });
});
