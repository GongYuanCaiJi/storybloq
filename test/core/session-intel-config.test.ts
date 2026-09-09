import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SESSION_INTEL_CONFIG,
  SESSION_INTEL_BOUNDS,
  readSessionIntelConfig,
  resolveSessionIntelConfig,
} from "../../src/core/session-intel/config.js";
import { SessionIntelConfigSchema, ConfigSchema } from "../../src/models/config.js";
import { minimalConfig } from "./test-factories.js";

function withProject(config: unknown, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-config-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    if (config !== undefined) {
      writeFileSync(join(root, ".story", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("sessionIntel config: hot-path reader", () => {
  it("absent block, absent file, and malformed file are the defaults with no notes", () => {
    for (const body of [undefined, "{}", "{not json", JSON.stringify({ sessionIntel: 7 }), JSON.stringify({ sessionIntel: [1] })]) {
      withProject(body, (root) => {
        const cfg = readSessionIntelConfig(root);
        expect(cfg).toEqual({ ...DEFAULT_SESSION_INTEL_CONFIG, notes: [] });
      });
    }
  });

  it("takes in-bounds values as written", () => {
    const cfg = resolveSessionIntelConfig({
      enabled: false, advisoryPct: 0.6, imperativePct: 0.9, ceilingFraction: 0.9, boundarySampleCount: 5,
      jumpAllowanceFloorTokens: 10_000, jumpAllowanceCapTokens: 20_000, maxSampleAgeMs: 0, compactPendingTtlMs: 10_000,
      stepPct: 0.1, banner: false, promptHook: false, guideDirective: false,
    });
    expect(cfg.notes).toEqual([]);
    expect(cfg.enabled).toBe(false);
    expect(cfg.advisoryPct).toBe(0.6);
    expect(cfg.imperativePct).toBe(0.9);
    expect(cfg.boundarySampleCount).toBe(5);
    expect(cfg.jumpAllowanceFloorTokens).toBe(10_000);
    expect(cfg.maxSampleAgeMs).toBe(0);
    expect(cfg.banner).toBe(false);
  });

  it("an out-of-bounds, non-integer, non-finite or wrong-typed number falls back per field with a note", () => {
    const cfg = resolveSessionIntelConfig({
      advisoryPct: 0.99, boundarySampleCount: 2.5, maxSampleAgeMs: "10", stepPct: Number.NaN, compactPendingTtlMs: 1,
    });
    expect(cfg.advisoryPct).toBe(DEFAULT_SESSION_INTEL_CONFIG.advisoryPct);
    expect(cfg.boundarySampleCount).toBe(DEFAULT_SESSION_INTEL_CONFIG.boundarySampleCount);
    expect(cfg.maxSampleAgeMs).toBe(DEFAULT_SESSION_INTEL_CONFIG.maxSampleAgeMs);
    expect(cfg.stepPct).toBe(DEFAULT_SESSION_INTEL_CONFIG.stepPct);
    expect(cfg.compactPendingTtlMs).toBe(DEFAULT_SESSION_INTEL_CONFIG.compactPendingTtlMs);
    expect(cfg.notes).toHaveLength(5);
    for (const key of ["advisoryPct", "boundarySampleCount", "maxSampleAgeMs", "stepPct", "compactPendingTtlMs"]) {
      expect(cfg.notes.some((n) => n.includes(`sessionIntel.${key}`))).toBe(true);
    }
  });

  it("a non-boolean flag falls back silently (flags have no bounds to report)", () => {
    const cfg = resolveSessionIntelConfig({ enabled: "no", banner: 0 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.banner).toBe(true);
    expect(cfg.notes).toEqual([]);
  });

  it("imperative at or below advisory falls back to the DEFAULT PAIR, not just the offender", () => {
    const equal = resolveSessionIntelConfig({ advisoryPct: 0.8, imperativePct: 0.8 });
    expect(equal.advisoryPct).toBe(0.7);
    expect(equal.imperativePct).toBe(0.85);
    expect(equal.notes).toHaveLength(1);
    expect(equal.notes[0]).toMatch(/imperativePct \(0\.8\) must exceed advisoryPct \(0\.8\)/);

    // The user set only advisoryPct above the default imperative: the pair rule still governs.
    const onlyAdvisory = resolveSessionIntelConfig({ advisoryPct: 0.9 });
    expect(onlyAdvisory.advisoryPct).toBe(0.7);
    expect(onlyAdvisory.imperativePct).toBe(0.85);
    expect(onlyAdvisory.notes).toHaveLength(1);
  });

  it("jump-allowance floor above cap falls back to the default pair", () => {
    const cfg = resolveSessionIntelConfig({ jumpAllowanceFloorTokens: 200_000, jumpAllowanceCapTokens: 100_000 });
    expect(cfg.jumpAllowanceFloorTokens).toBe(25_000);
    expect(cfg.jumpAllowanceCapTokens).toBe(150_000);
    expect(cfg.notes).toHaveLength(1);
    expect(cfg.notes[0]).toMatch(/jumpAllowanceFloorTokens \(200000\) exceeds jumpAllowanceCapTokens \(100000\)/);
    // Equal floor and cap is legal.
    expect(resolveSessionIntelConfig({ jumpAllowanceFloorTokens: 5, jumpAllowanceCapTokens: 5 }).notes).toEqual([]);
  });

  it("a per-field fallback that then violates the pair rule is reported twice, once per rule", () => {
    // advisoryPct out of bounds -> default 0.7; imperativePct 0.65 is in bounds but below 0.7.
    const cfg = resolveSessionIntelConfig({ advisoryPct: 2, imperativePct: 0.65 });
    expect(cfg.notes).toHaveLength(2);
    expect(cfg.imperativePct).toBe(0.85);
  });

  it("unknown keys pass through untouched", () => {
    expect(resolveSessionIntelConfig({ futureKey: { nested: true } }).notes).toEqual([]);
  });
});

describe("sessionIntel config: hot-path reader agrees with the zod schema", () => {
  const numericKeys = Object.keys(SESSION_INTEL_BOUNDS) as Array<keyof typeof SESSION_INTEL_BOUNDS>;

  it("every numeric field: min and max accepted, just outside rejected, integer rule identical", () => {
    for (const key of numericKeys) {
      const b = SESSION_INTEL_BOUNDS[key];
      const step = b.integer ? 1 : 0.001;
      for (const value of [b.min, b.max]) {
        expect(SessionIntelConfigSchema.safeParse({ [key]: value }).success, `${key}=${value} schema`).toBe(true);
        // Pair rules can fire on a legal single value; only the per-field note must be absent.
        const notes = resolveSessionIntelConfig({ [key]: value }).notes;
        expect(notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`)), `${key}=${value} reader`).toBe(false);
      }
      for (const value of [b.min - step, b.max + step]) {
        expect(SessionIntelConfigSchema.safeParse({ [key]: value }).success, `${key}=${value} schema`).toBe(false);
        const notes = resolveSessionIntelConfig({ [key]: value }).notes;
        expect(notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`)), `${key}=${value} reader`).toBe(true);
      }
      if (b.integer) {
        const frac = b.min + 0.5;
        expect(SessionIntelConfigSchema.safeParse({ [key]: frac }).success).toBe(false);
        expect(resolveSessionIntelConfig({ [key]: frac }).notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`))).toBe(true);
      }
    }
  });

  it("the schema and the reader name the same set of keys", () => {
    const schemaKeys = Object.keys(SessionIntelConfigSchema.shape).sort();
    const readerKeys = Object.keys(DEFAULT_SESSION_INTEL_CONFIG).sort();
    expect(schemaKeys).toEqual(readerKeys);
  });

  it("the block is optional at the ConfigSchema root and passes unknown keys through", () => {
    const parsed = ConfigSchema.parse({ ...minimalConfig, sessionIntel: { advisoryPct: 0.6, futureKey: 1 } });
    expect(parsed.sessionIntel).toEqual({ advisoryPct: 0.6, futureKey: 1 });
    expect(ConfigSchema.parse(minimalConfig).sessionIntel).toBeUndefined();
  });

  it("the pair rules are NOT in the schema: a violated pair still parses, so it falls back instead of throwing", () => {
    expect(SessionIntelConfigSchema.safeParse({ advisoryPct: 0.9, imperativePct: 0.8 }).success).toBe(true);
    expect(SessionIntelConfigSchema.safeParse({ jumpAllowanceFloorTokens: 9, jumpAllowanceCapTokens: 1 }).success).toBe(true);
  });
});
