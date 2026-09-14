/**
 * ISS-1197 commit 3 part B: RED-first doc-anchor tests over the shipped
 * surfaces.
 *
 * Two things are pinned here.
 *
 * 1. The handover cadence ruling. One sentence, byte-identical, in the three
 *    files a driving session actually reads: SKILL.md (every session),
 *    duet-mode.md (a manager with workers) and orchestrator-mode.md (a wave).
 *    It carries five points that were previously only in the owner's ruling:
 *    the three moments a handover belongs at, that the pushed pressure line
 *    is advice rather than an instruction to write one per message, that a
 *    percentage is never a reason to stop, that one continue after a written
 *    handover is allowed, and that a worker above 90 percent is not asked for
 *    status.
 *
 * 2. The three-state enumerations. `compact-needed` shipped in commit 2 and
 *    every user-facing list of states still said there were three, and every
 *    description of the UserPromptSubmit hook line still said it fires only
 *    at `imperative`.
 *
 * Every assertion reads the real on-disk file (or the real exported
 * registry), so these fail against the pre-commit-3 text and pass after.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, MCP_TOOLS } from "../../src/cli/commands/reference.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_DIR = join(PROJECT_ROOT, "src", "skill");

const read = (name: string) => readFileSync(join(SKILL_DIR, name), "utf-8");

/** The ruling, byte-identical wherever it appears. */
export const CADENCE_RULING =
  "Cadence ruling: handover before auto-compaction, after a major item completes, and after a batch of issues or one big issue resolves; the pushed line is advice, not one handover per message; never stop at a percentage; one continue after a handover is allowed; no status demands to a worker above 90 percent.";

describe("ISS-1197 commit 3: the handover cadence ruling reaches the skill text", () => {
  it.each(["SKILL.md", "duet-mode.md", "orchestrator-mode.md"])("%s carries the ruling verbatim", (file) => {
    expect(read(file)).toContain(CADENCE_RULING);
  });

  it("the ruling names all five points", () => {
    // Read off the one string every file shares, so a partial paraphrase in
    // any single file cannot satisfy the per-file assertions above.
    expect(CADENCE_RULING).toContain("before auto-compaction");
    expect(CADENCE_RULING).toContain("after a major item completes");
    expect(CADENCE_RULING).toContain("after a batch of issues or one big issue resolves");
    expect(CADENCE_RULING).toContain("not one handover per message");
    expect(CADENCE_RULING).toContain("never stop at a percentage");
    expect(CADENCE_RULING).toContain("one continue after a handover is allowed");
    expect(CADENCE_RULING).toContain("no status demands to a worker above 90 percent");
  });

  it("carries no em dash in any copy", () => {
    // Built from the codepoint so this file itself stays em-dash free.
    expect(CADENCE_RULING).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("ISS-1197 commit 3: the state enumerations name compact-needed", () => {
  it("SKILL.md lists the fourth state with its threshold", () => {
    expect(read("SKILL.md")).toContain("`imperative` (85% minus a per-turn jump allowance) or `compact-needed` (95%)");
  });

  it("SKILL.md says the prompt line fires at imperative AND at compact-needed", () => {
    expect(read("SKILL.md")).toContain("at `imperative` and at `compact-needed` the next prompt carries");
  });

  it("SKILL.md names compact-needed in the banner list", () => {
    expect(read("SKILL.md")).toContain("an `advisory`, `imperative` or `compact-needed` banner");
  });

  it("SKILL.md no longer promises the stamp drops the state to advisory", () => {
    // Untrue at compact-needed (commit 2), and the byte it frees pays for the
    // ruling above. Pinned so it cannot drift back in.
    expect(read("SKILL.md")).not.toContain("drops the state back to `advisory`");
  });

  it("autonomous-mode.md names compact-needed in the guide directive paragraph", () => {
    const text = read("autonomous-mode.md");
    expect(text).toContain("or `compact-needed` (95%)");
    expect(text).toContain("fires at `imperative` and at `compact-needed`");
  });

  it("setup-flow.md says the UserPromptSubmit hook injects at both states", () => {
    expect(read("setup-flow.md")).toContain("injects one line only when pressure is imperative or compact-needed");
  });

  it("the MCP tool description enumerates four states", () => {
    const tools = readFileSync(join(PROJECT_ROOT, "src", "mcp", "tools.ts"), "utf-8");
    expect(tools).toContain("pressure state (ok/advisory/imperative/compact-needed)");
    expect(tools).not.toContain("pressure state (ok/advisory/imperative)");
  });

  it("the CLI reference entry enumerates four states", () => {
    const cmd = COMMANDS.find((c) => c.name === "session intel");
    expect(cmd?.description).toContain("(ok/advisory/imperative/compact-needed)");
  });

  it("the MCP reference entry enumerates four states", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "storybloq_session_intel");
    expect(tool?.description).toContain("(ok/advisory/imperative/compact-needed)");
  });
});
