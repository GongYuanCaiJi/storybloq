import { describe, it, expect } from "vitest";
import { resolveCeiling, type ResolveCeilingInput } from "../../src/core/session-intel/ceiling-resolver.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import type { LedgerEntry } from "../../src/core/session-intel/boundary-ledger.js";

const cfg = resolveSessionIntelConfig(null);
const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const ME = "me";

function entry(sessionId: string, minute: number, pre: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { sessionId, era: "1:2", captureKind: "startup", timestamp: at(minute), trigger: "auto", preTokens: pre, postTokens: 30_000, autoCompactWindowAtStart: 450_000, ...over };
}

function input(over: Partial<ResolveCeilingInput> = {}): ResolveCeilingInput {
  return {
    sessionId: ME,
    target: { era: "1:2", capture: { captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: at(-10) } },
    ledger: [],
    liveSetting: null,
    lastAssistantModel: "claude-opus-5",
    oneMillionFlag: null,
    modelEvidence: "none",
    highWaterMark: null,
    cfg,
    ...over,
  };
}

describe("resolveCeiling precedence", () => {
  it("measured-session: median of this session's auto boundaries in the target era; auto-only differs from all", () => {
    const ledger = [entry(ME, 1, 410_000), entry(ME, 2, 420_000), entry(ME, 3, 430_000), entry(ME, 4, 331_000, { trigger: "manual" }), entry(ME, 5, 100, { trigger: "unknown" })];
    const r = resolveCeiling(input({ ledger }));
    expect(r).toMatchObject({ source: "measured-session", ceiling: 420_000, confidence: "high", sampleCount: 3, effectiveSampleWindow: 3, conflict: null });
    expect(r.basis).toMatch(/window 3 of 20 configured/);
    expect(resolveCeiling(input({ ledger: ledger.slice(0, 2) }))).toMatchObject({ confidence: "medium", ceiling: 415_000 });
  });

  it("era-keyed: a 368,739 boundary from the 400k era never pools with the 450k-era capture; unclassified never pools; a new era ignores prior measurements", () => {
    const ledger = [entry(ME, 1, 368_739, { era: "1:1", autoCompactWindowAtStart: 400_000 }), entry(ME, 2, 368_739, { era: null })];
    const r = resolveCeiling(input({ ledger }));
    expect(r.source).toBe("setting");
    expect(r.ceiling).toBeCloseTo(0.925 * 450_000);
    // Same ledger, target era null: measured-session is impossible.
    expect(resolveCeiling(input({ ledger: [entry(ME, 1, 417_000)], target: { era: null, capture: input().target.capture } })).source).toBe("setting");
  });

  it("measured-project requires >= 2 sessions and >= 5 startup-captured, era-stamped boundaries with the SAME window; late entries are excluded", () => {
    const others = [entry("a", 1, 415_000), entry("a", 2, 416_000), entry("a", 3, 417_000), entry("b", 4, 418_000), entry("b", 5, 419_000)];
    expect(resolveCeiling(input({ ledger: others }))).toMatchObject({ source: "measured-project", ceiling: 417_000, confidence: "medium", independentSessions: 2, sampleCount: 5 });
    expect(resolveCeiling(input({ ledger: [...others, entry("c", 6, 420_000)] })).confidence).toBe("high");
    expect(resolveCeiling(input({ ledger: others.slice(0, 4) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, sessionId: "a" })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, captureKind: "late" as const })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, autoCompactWindowAtStart: 400_000 })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, era: null })) })).source).toBe("setting");
    // Diversity is judged on the SELECTED window: one session supplying every
    // newest boundary, with two other sessions only in older entries, does not qualify.
    const small = resolveSessionIntelConfig({ boundarySampleCount: 5 });
    const skewed = [entry("x", 1, 400_000), entry("y", 2, 401_000), ...Array.from({ length: 5 }, (_, i) => entry("a", 10 + i, 417_000))];
    expect(resolveCeiling(input({ ledger: skewed, cfg: small })).source).toBe("setting");
    // Unknown-trigger boundaries never pool.
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, trigger: "unknown" as const })) })).source).toBe("setting");
    // Absent capture: project path skipped entirely.
    expect(resolveCeiling(input({ ledger: others, target: { era: "1:2", capture: null } })).source).toBe("model");
  });

  it("setting: startup high, late medium, live read medium with its basis", () => {
    expect(resolveCeiling(input())).toMatchObject({ source: "setting", confidence: "high", autoCompactWindowAtStart: 450_000, captureKind: "startup" });
    expect(resolveCeiling(input({ target: { era: "1:2", capture: { captureKind: "late", autoCompactWindowAtStart: 450_000, capturedAt: at(0) } } }))).toMatchObject({ confidence: "medium" });
    const live = resolveCeiling(input({ target: { era: null, capture: null }, liveSetting: { value: 400_000, basis: "live read, no capture" } }));
    expect(live).toMatchObject({ source: "setting", confidence: "medium", ceiling: 0.925 * 400_000 });
    expect(live.basis).toMatch(/live read, no capture/);
  });

  it("model: 1M flag only from evidence; full medium, tail low, none computes for 200k with a conflict", () => {
    const noCapture = { era: null, capture: null };
    expect(resolveCeiling(input({ target: noCapture, oneMillionFlag: true, modelEvidence: "full" }))).toMatchObject({ source: "model", nativeWindow: 1_000_000, confidence: "medium", conflict: null });
    expect(resolveCeiling(input({ target: noCapture, oneMillionFlag: false, modelEvidence: "tail" }))).toMatchObject({ nativeWindow: 200_000, confidence: "low" });
    expect(resolveCeiling(input({ target: noCapture, modelEvidence: "none" }))).toMatchObject({ nativeWindow: 200_000, confidence: "low", conflict: "no model-window evidence", ceiling: 185_000 });
  });

  it("a model change with a window set leaves the ceiling unchanged", () => {
    const a = resolveCeiling(input({ lastAssistantModel: "claude-opus-5" }));
    const b = resolveCeiling(input({ lastAssistantModel: "claude-sonnet-5", oneMillionFlag: true, modelEvidence: "full" }));
    expect(b.ceiling).toBe(a.ceiling);
    expect(b.source).toBe("setting");
  });

  it("overshoot never promotes: HWM above the forecast keeps the ceiling and raises the conflict, never a 1M jump", () => {
    const r = resolveCeiling(input({ highWaterMark: 460_000 }));
    expect(r.ceiling).toBeCloseTo(416_250);
    expect(r.conflict).toBe("high-water exceeds forecast");
    expect(r.nativeWindow).toBeNull();
    const model = resolveCeiling(input({ target: { era: null, capture: null }, modelEvidence: "none", highWaterMark: 250_000 }));
    expect(model.conflict).toBe("no model-window evidence; high-water exceeds forecast");
    expect(model.ceiling).toBe(185_000);
  });

  it("nothing at all is unknown", () => {
    const r = resolveCeiling(input({ target: { era: null, capture: null }, lastAssistantModel: null }));
    expect(r).toMatchObject({ source: "unknown", ceiling: null, confidence: null });
  });

  it("config fallbacks are surfaced in basis", () => {
    const bad = resolveSessionIntelConfig({ advisoryPct: 0.9, imperativePct: 0.8 });
    expect(resolveCeiling(input({ cfg: bad })).basis).toMatch(/config: sessionIntel.imperativePct/);
  });
});
