import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { SUPPORTED_TEAM_FEATURES, assertTeamWriteCapabilities, currentCliVersion } from "../../src/core/team-capabilities.js";
import type { Config } from "../../src/models/config.js";

// The version this package's own manifest declares. In src-context runs (vitest)
// currentCliVersion must fall back to exactly this file; in dist it is baked by tsup.
const OWN_PACKAGE_VERSION = (JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }).version;

// The canonical team-feature vocabulary lives in ONE checked-in file,
// test/fixtures/team-features.json. ISS-684: both the TS SUPPORTED_TEAM_FEATURES
// (asserted here) and the Swift Config.TeamCapabilities.supportedFeatures (asserted
// in TeamModeFieldTests against this same file) are pinned to it, so the two
// implementations cannot silently diverge -- passing both suites requires both to
// equal the fixture, hence each other.
const CANONICAL_TEAM_FEATURES = JSON.parse(
  readFileSync(new URL("../fixtures/team-features.json", import.meta.url), "utf8"),
) as string[];

function teamConfig(requiredFeatures: string[]): Config {
  return {
    version: 2,
    schemaVersion: 2,
    project: "t",
    type: "npm",
    language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    team: { enabled: true, requiredFeatures },
  } as unknown as Config;
}

describe("SUPPORTED_TEAM_FEATURES vocabulary (ISS-684)", () => {
  it("matches the canonical list exactly (pins TS<->Swift parity)", () => {
    expect([...SUPPORTED_TEAM_FEATURES].sort()).toEqual([...CANONICAL_TEAM_FEATURES].sort());
  });

  it("does not contain the stale spec-example alias 'display-id-reconcile'", () => {
    // N-059's example config used display-id-reconcile; the canonical feature is
    // 'reconcile'. This guards against re-introducing the diverged alias.
    expect(SUPPORTED_TEAM_FEATURES.has("display-id-reconcile")).toBe(false);
    expect(SUPPORTED_TEAM_FEATURES.has("reconcile")).toBe(true);
  });
});

describe("currentCliVersion (ISS-748)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the build-time STORYBLOQ_VERSION constant", () => {
    vi.stubEnv("STORYBLOQ_VERSION", "9.9.9");
    expect(currentCliVersion()).toBe("9.9.9");
  });

  it("falls back to the package's own package.json when the constant is absent", () => {
    vi.stubEnv("STORYBLOQ_VERSION", undefined);
    expect(currentCliVersion()).toBe(OWN_PACKAGE_VERSION);
    // ISS-748: the broken relative resolution read the WORKSPACE root manifest (0.0.1)
    expect(currentCliVersion()).not.toBe("0.0.1");
  });

  it("treats an empty STORYBLOQ_VERSION as absent and falls back", () => {
    vi.stubEnv("STORYBLOQ_VERSION", "");
    expect(currentCliVersion()).toBe(OWN_PACKAGE_VERSION);
  });
});

describe("assertTeamWriteCapabilities minCliVersion gate (ISS-748)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function gateConfig(minCliVersion: string): Config {
    const base = teamConfig([]);
    return { ...base, team: { ...base.team, minCliVersion } } as unknown as Config;
  }

  it("passes when the current version meets the minimum", () => {
    vi.stubEnv("STORYBLOQ_VERSION", "9.9.9");
    expect(() => assertTeamWriteCapabilities(gateConfig("1.0.0"))).not.toThrow();
  });

  it("throws version_mismatch reporting both versions when below the minimum", () => {
    vi.stubEnv("STORYBLOQ_VERSION", "0.5.0");
    expect(() => assertTeamWriteCapabilities(gateConfig("1.0.0")))
      .toThrow(/requires storybloq CLI 1\.0\.0 or later; current CLI is 0\.5\.0/);
  });
});

describe("assertTeamWriteCapabilities requiredFeatures gate", () => {
  it("passes when all required features are supported", () => {
    expect(() => assertTeamWriteCapabilities(teamConfig(["merge-driver", "reconcile"]))).not.toThrow();
  });

  it("throws when a required feature is unsupported", () => {
    expect(() => assertTeamWriteCapabilities(teamConfig(["merge-driver", "warp-drive"])))
      .toThrow(/unsupported team feature/i);
  });

  it("does not gate a non-team config", () => {
    const solo = { ...teamConfig([]), team: undefined } as unknown as Config;
    expect(() => assertTeamWriteCapabilities(solo)).not.toThrow();
  });
});
