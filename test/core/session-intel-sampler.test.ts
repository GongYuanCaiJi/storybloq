import { describe, it, expect } from "vitest";
import { computeSample, handoverSuppresses, jumpAllowanceFor, p90 } from "../../src/core/session-intel/sampler.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../src/presence/session-intel-fields.js";
import type { CeilingResolution, ScanResult } from "../../src/core/session-intel/types.js";

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

const sample = (tokens: number | null, over: { deltas?: number[]; record?: SessionIntelPresence | null; ceiling?: CeilingResolution } = {}) =>
  computeSample({ scan: scan(tokens, over.deltas ?? []), ceiling: over.ceiling ?? ceiling(), cfg, sampledBy: "query", sampledAt: NOW, record: over.record ?? null });

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
