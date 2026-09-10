/**
 * T-496 (pen ruling): file-path-to-byte-ceiling table for SKILL.md,
 * session-guard.md, and every mode file installed by setup-skill.ts's
 * `supportFiles` array.
 *
 * Ceilings are the measured post-split size of each file, rounded up to
 * the next 1,000 bytes. They pin against regrowth -- they are NOT design
 * targets. `setup-flow.md` is over budget today (ISS-1146); its ceiling is
 * its own measured size like every other file. This ticket does not
 * decide ISS-1146.
 *
 * The file list itself is read from the real `supportFiles` array in
 * setup-skill.ts, not a hand-duplicated copy, so a new mode file added
 * there with no matching ceiling row fails this test rather than silently
 * shipping unbudgeted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_DIR = join(PROJECT_ROOT, "src", "skill");
const SETUP_SKILL_TS_PATH = join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts");

function readSupportFilesArray(): string[] {
  const src = readFileSync(SETUP_SKILL_TS_PATH, "utf-8");
  const match = src.match(/const supportFiles = \[([^\]]*)\];/);
  if (!match) throw new Error("supportFiles array not found in setup-skill.ts");
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

const CEILINGS: Readonly<Record<string, number>> = {
  // 56,000: T-460 Leg C step 1 (Settings extraction to settings.md) dropped
  // SKILL.md to 55,231 measured bytes; rounded up to the next 1,000. Lowered
  // from the T-496-era 65,000 (64,399 measured then) to keep the ceiling
  // pinning tightly against regrowth rather than leaving slack an
  // accumulating edit could silently reoccupy. Measured, not estimated.
  "SKILL.md": 56000,
  "settings.md": 11000, // T-460 Leg C step 1: 10,194 measured, rounded up
  "session-guard.md": 41000,
  "setup-flow.md": 47000, // ISS-1146: already over a design target, ceiling only pins regrowth
  "autonomous-mode.md": 27000,
  "reference.md": 35000,
  "federation-setup.md": 14000,
  "orchestrator-mode.md": 47000,
  "duet-mode.md": 9000,
  "triage-mode.md": 17000,
  "bus-mode.md": 31000,
  "session-guard-fallback.md": 117000,
  "review-contract-template.md": 5000,
};

describe("skill mode-budget ceilings (T-496)", () => {
  it("SKILL.md plus every real supportFiles entry has a recorded ceiling and stays under it", () => {
    const files = ["SKILL.md", ...readSupportFilesArray()];
    expect(files.length).toBeGreaterThan(1);
    for (const filename of files) {
      const ceiling = CEILINGS[filename];
      if (ceiling === undefined) {
        throw new Error(
          `${filename} is installed by setup-skill.ts's supportFiles array but has no ceiling row in CEILINGS -- add one before shipping`,
        );
      }
      const size = readFileSync(join(SKILL_DIR, filename)).length;
      expect(size, `${filename} (${size} bytes) exceeds its ${ceiling}-byte ceiling`).toBeLessThanOrEqual(ceiling);
    }
  });
});
