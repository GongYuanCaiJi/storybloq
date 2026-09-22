/**
 * T-524 scope 5 and 7: skill-doc anchors for the glossary.
 *
 * Built on T-494's pattern (`skill-ruling-anchors.test.ts`), including the
 * reason its anchors are LOCAL `as const` arrays rather than exports from
 * `src/`: an anchor set is a test fixture, and shipping it in the CLI would put
 * test data in the published package. All three anti-vacuity guards are here
 * too -- the anchor arrays are asserted non-empty, each heading is asserted to
 * occur exactly once, and the extracted region is asserted non-empty before any
 * anchor is checked -- because an extractor that returns an empty slice makes
 * every presence anchor fail for the wrong reason and every absence anchor pass
 * over nothing.
 *
 * ONE THING HERE IS NOT A TEXT ANCHOR and is the reason this file exists rather
 * than three more rows in T-494's: the cap in the Step 2 sentence is checked
 * against `TERM_DIGEST_CAP` in the source, not against a literal 40. A written
 * cap and a computed cap are two copies of one number, and the copy in prose is
 * the one nobody recompiles. Changing the constant without the sentence now
 * fails here instead of silently telling every session the wrong bound.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERM_DIGEST_CAP } from "../../src/core/glossary.js";

/**
 * From `heading` to the next heading of EQUAL OR HIGHER level, so a parent
 * heading closing the section cannot swallow unrelated content. Copied rather
 * than imported from the T-494 file for the reason recorded there: importing
 * another TEST file re-runs its whole suite inside this one.
 */
function extractSection(markdown: string, heading: string): { found: "one" | "none" | "many"; section: string } {
  const lines = markdown.split("\n");
  const level = /^(#{1,6})\s/.exec(heading)?.[1].length ?? 0;
  const indices = lines.map((line, i) => (line.trim() === heading ? i : -1)).filter((i) => i >= 0);
  if (indices.length === 0) return { found: "none", section: "" };
  if (indices.length > 1) return { found: "many", section: "" };

  const start = indices[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i]!);
    if (match && match[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return { found: "one", section: lines.slice(start, end).join("\n") };
}

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "..", "src", "skill", "SKILL.md");
const ORCHESTRATOR_PATH = join(here, "..", "..", "src", "skill", "orchestrator-mode.md");

const STEP2_HEADING = "## Step 2: Load Context (Default /story Behavior)";
const GLOSSARY_HEADING = "## Glossary";

/**
 * Step 2 is the bounded-load contract (G-C). The anchors are the two things a
 * reader gets WRONG without them: that the digest is names only, and that a
 * short list is not evidence a word is undefined.
 */
const STEP2_ANCHORS = {
  presence: ["storybloq_term_list", "digest: true", "omittedCore", "not the whole glossary", "storybloq_term_get"],
} as const;

/**
 * The section anchors are the advisory rule (G-A) and the two behaviours that
 * refuse or warn, which are the only places the glossary can surprise someone.
 *
 * The absence anchors are claims that would be FALSE rather than merely absent.
 * A skill file that told an agent a term match renames or blocks anything would
 * produce exactly the enforcement this catalog is contracted not to be, and an
 * agent reading it would act on the instruction, not on the code.
 */
const GLOSSARY_ANCHORS = {
  presence: [
    "renames nothing, rewrites nothing, and refuses nothing",
    "no gate consults it",
    "storybloq_term_match",
    "One word belongs to one entry",
    "THIN",
    "warn, never error",
  ],
  absence: ["rename the ticket", "refuse the write", "must use the canonical term"],
} as const;

/** G-B: the authoring path is a report field the pen files from, not an agent write. */
const ORCHESTRATOR_ANCHORS = {
  presence: ["`terms` array (each entry: term, definition, distinction)", "nothing an agent reports becomes a term until it does"],
} as const;

describe("T-524 skill doc: anchor sets are not empty", () => {
  it("has anchors to check, so an emptied constant fails loudly", () => {
    expect(STEP2_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(GLOSSARY_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(GLOSSARY_ANCHORS.absence.length).toBeGreaterThan(0);
    expect(ORCHESTRATOR_ANCHORS.presence.length).toBeGreaterThan(0);
  });
});

describe("T-524 skill doc: SKILL.md Step 2 loads the glossary bounded", () => {
  it("contains EXACTLY ONE Step 2 heading", async () => {
    expect(extractSection(await readFile(SKILL_PATH, "utf-8"), STEP2_HEADING).found).toBe("one");
  });

  it("extracts a NON-EMPTY Step 2 section before any anchor is checked", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), STEP2_HEADING);
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section.split("\n").length).toBeGreaterThan(1);
  });

  it("carries every presence anchor INSIDE Step 2", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), STEP2_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of STEP2_ANCHORS.presence) {
      expect(section).toContain(anchor);
    }
  });

  it("names the SAME cap the code computes, and the over-cap behaviour", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), STEP2_HEADING);
    expect(section.length).toBeGreaterThan(0);
    // Guard the guard: a cap of 0 or NaN would make the two assertions below
    // pass against prose that happens to contain the string.
    expect(Number.isInteger(TERM_DIGEST_CAP)).toBe(true);
    expect(TERM_DIGEST_CAP).toBeGreaterThan(1);
    expect(section, `Step 2 must name the digest cap (${TERM_DIGEST_CAP})`).toContain(`${TERM_DIGEST_CAP} or fewer`);
    // The whole clause, not the number: "above 40" alone would pass a sentence
    // that said every name still loads above the cap, which is the opposite of
    // what `termDigest` does.
    expect(section, "Step 2 must say only core terms load ABOVE the cap").toContain(
      `only the ones marked \`core\` above ${TERM_DIGEST_CAP}`,
    );
  });
});

describe("T-524 skill doc: SKILL.md has a Glossary section and it says the glossary is advisory", () => {
  it("contains EXACTLY ONE Glossary heading", async () => {
    expect(extractSection(await readFile(SKILL_PATH, "utf-8"), GLOSSARY_HEADING).found).toBe("one");
  });

  it("extracts a NON-EMPTY Glossary section before any anchor is checked", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), GLOSSARY_HEADING);
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section.split("\n").length).toBeGreaterThan(1);
  });

  it("carries every presence anchor INSIDE the Glossary section", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), GLOSSARY_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of GLOSSARY_ANCHORS.presence) {
      expect(section).toContain(anchor);
    }
  });

  it("carries NO absence anchor inside the Glossary section", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), GLOSSARY_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of GLOSSARY_ANCHORS.absence) {
      expect(section).not.toContain(anchor);
    }
  });
});

describe("T-524 skill doc: orchestrator-mode.md carries the terms report field", () => {
  it("carries every presence anchor", async () => {
    const md = await readFile(ORCHESTRATOR_PATH, "utf-8");
    expect(md.trim().length).toBeGreaterThan(0);
    for (const anchor of ORCHESTRATOR_ANCHORS.presence) {
      expect(md).toContain(anchor);
    }
  });
});
