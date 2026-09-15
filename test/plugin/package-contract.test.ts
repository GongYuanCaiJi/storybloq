/**
 * T-509 part 1: codex-claude-bridge is bundled as an OPTIONAL dependency,
 * pinned exactly. Under optionalDependencies npm skips the package when its
 * native module fails to build and the install still succeeds; under
 * dependencies the same failure would break every install of storybloq.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("codex-claude-bridge bundling (T-509)", () => {
  it("lives under optionalDependencies with an exact version pin", () => {
    const pin = pkg.optionalDependencies?.["codex-claude-bridge"];
    // The exact vetted release: a bump is a deliberate edit here and in RELEASE.md.
    expect(pin).toBe("1.8.0");
  });
  it("is never a hard or peer dependency", () => {
    expect(pkg.dependencies?.["codex-claude-bridge"]).toBeUndefined();
    expect(pkg.peerDependencies?.["codex-claude-bridge"]).toBeUndefined();
  });
});
