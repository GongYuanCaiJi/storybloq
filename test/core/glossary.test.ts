import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One hook, on the rename `atomicWrite` finishes with. Everything else is the
 * real implementation: this controls WHEN the write fails, it does not
 * simulate the filesystem.
 */
const fsHooks = vi.hoisted(() => ({
  failRenameTo: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: (async (from: string, to: string) => {
      if (fsHooks.failRenameTo !== null && String(to).endsWith(fsHooks.failRenameTo)) {
        fsHooks.failRenameTo = null; // one shot
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

const {
  glossaryCatalog,
  sortTerms,
  checkTerms,
  matchTerms,
  termDigest,
  buildTermReferenceIndex,
  TERM_DIGEST_CAP,
} = await import("../../src/core/glossary.js");
type TermReferenceIndex = import("../../src/core/glossary.js").TermReferenceIndex;
type Term = import("../../src/models/glossary.js").Term;

const roots: string[] = [];
afterEach(() => {
  fsHooks.failRenameTo = null;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeProject(glossary?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "sb-glossary-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  // A real project, not just a directory named `.story`: `mutate` takes the
  // project lock, which loads the project, so a fixture without a config would
  // make every write here fail for a reason that has nothing to do with the
  // glossary -- and every `rejects.toThrow()` below would pass vacuously.
  writeFileSync(
    join(story, "config.json"),
    JSON.stringify(
      {
        version: 2,
        project: "glossary-fixture",
        type: "npm",
        language: "ts",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(story, "roadmap.json"),
    JSON.stringify(
      { title: "glossary-fixture", date: "2026-09-21", phases: [{ id: "p1", label: "P1", name: "Alpha", description: "First." }], blockers: [] },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  if (glossary !== undefined) {
    writeFileSync(join(story, "glossary.json"), JSON.stringify(glossary, null, 2) + "\n", "utf-8");
  }
  return root;
}

function term(overrides: Partial<Term> & { id: string; term: string }): Term {
  return {
    definition: `What ${overrides.term} means here.`,
    updatedAt: "2026-09-21T18:44:42.000Z",
    ...overrides,
  } as Term;
}

const emptyIndex: TermReferenceIndex = {
  capabilityIds: new Set<string>(),
  capabilityScanIncomplete: false,
  rulingIds: new Set<string>(),
  rulingScanIncomplete: false,
  rulingUnavailableIds: new Set<string>(),
};

function indexWith(over: Partial<TermReferenceIndex>): TermReferenceIndex {
  return { ...emptyIndex, ...over };
}

/**
 * Every byte under `.story/`, subdirectories included, so a test can assert
 * nothing moved anywhere in the ledger and not only beside glossary.json. A
 * read failure propagates: a snapshot that swallowed one would compare equal
 * across a change it could not see.
 */
function storyBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else out[next] = readFileSync(join(root, next), "utf-8");
    }
  };
  walk(".story");
  return out;
}

describe("glossaryCatalog load", () => {
  it("loads a missing file as the schema-shaped empty document, not as an error", () => {
    const { doc, present } = glossaryCatalog.load(makeProject());
    expect(present).toBe(false);
    expect(doc).toEqual({ version: 1, terms: [] });
  });

  it("loads an empty terms array as empty and present", () => {
    const { doc, present } = glossaryCatalog.load(makeProject({ version: 1, terms: [] }));
    expect(present).toBe(true);
    expect(doc.terms).toEqual([]);
  });

  it("refuses a document whose invariant a hand edit or a merge broke", () => {
    const root = makeProject({
      version: 1,
      terms: [term({ id: "term-pen", term: "pen" }), term({ id: "term-pen-two", term: "Pen" })],
    });
    expect(() => glossaryCatalog.load(root)).toThrow(/glossary\.json/);
  });
});

describe("glossaryCatalog write", () => {
  it("creates the document on the first add", async () => {
    const root = makeProject();
    await glossaryCatalog.mutate(root, (doc) => ({ ...doc, terms: [term({ id: "term-pen", term: "pen" })] }));
    const reloaded = glossaryCatalog.load(root);
    expect(reloaded.present).toBe(true);
    expect(reloaded.doc.terms.map((t) => t.id)).toEqual(["term-pen"]);
  });

  it("refuses a write that would break the ownership invariant, and the stored bytes are untouched", async () => {
    const root = makeProject({ version: 1, terms: [term({ id: "term-pen", term: "pen" })] });
    const before = storyBytes(root);
    await expect(
      glossaryCatalog.mutate(root, (doc) => ({
        ...doc,
        terms: [...doc.terms, term({ id: "term-other", term: "PEN" })],
      })),
    ).rejects.toThrow(/already owned by/);
    expect(storyBytes(root)).toEqual(before);
  });

  it("leaves the previous file intact when the rename fails part-way", async () => {
    const root = makeProject({ version: 1, terms: [term({ id: "term-pen", term: "pen" })] });
    const before = storyBytes(root);
    fsHooks.failRenameTo = "glossary.json";
    await expect(
      glossaryCatalog.mutate(root, (doc) => ({ ...doc, terms: [...doc.terms, term({ id: "term-hands", term: "hands" })] })),
    ).rejects.toThrow(/Failed to write glossary\.json/);
    expect(storyBytes(root)).toEqual(before);
    // And no temp file was left behind for the next reader to trip over.
    expect(readdirSync(join(root, ".story")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("sorts entries by id, so a diff shows what changed and not where an append landed", () => {
    const sorted = sortTerms([
      term({ id: "term-wave", term: "wave" }),
      term({ id: "term-hands", term: "hands" }),
      term({ id: "term-pen", term: "pen" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["term-hands", "term-pen", "term-wave"]);
  });
});

describe("matchTerms", () => {
  const entries = [
    term({ id: "term-pen", term: "pen", aliases: ["the pen"] }),
    term({ id: "term-hands", term: "hands" }),
  ];

  it("matches a whole word regardless of case", () => {
    expect(matchTerms("The Pen dispatches to hands", entries).map((m) => m.id)).toEqual(["term-hands", "term-pen"]);
  });

  it("does not match a word that merely starts with the term", () => {
    expect(matchTerms("this ticket is pending review", entries)).toEqual([]);
    expect(matchTerms("open the pendant", entries)).toEqual([]);
  });

  it("does not match a term inside a longer word on either side", () => {
    expect(matchTerms("happens", entries)).toEqual([]);
    expect(matchTerms("underhands", entries)).toEqual([]);
  });

  it("matches an alias and says so", () => {
    // The alias must not CONTAIN the canonical term, or the term would match
    // first and this would assert nothing about aliases at all.
    const inspector = term({ id: "term-inspector", term: "inspector", aliases: ["reviewer"] });
    const [match] = matchTerms("ask the reviewer to judge it", [inspector]);
    expect(match?.id).toBe("term-inspector");
    expect(match?.viaAlias).toBe(true);
    expect(match?.matchedWord).toBe("reviewer");
  });

  it("returns one match per entry even when the term and an alias both appear", () => {
    const matches = matchTerms("the pen is the pen", entries);
    expect(matches.filter((m) => m.id === "term-pen")).toHaveLength(1);
    // The canonical term wins over an alias that also matched.
    expect(matches[0]?.viaAlias).toBe(false);
  });

  it("uses a Unicode boundary, so an accented word is not split into a match", () => {
    // `\b` is ASCII-only and would fire between `e` and `n` here.
    expect(matchTerms("péniche", [term({ id: "term-p", term: "n" })])).toEqual([]);
    expect(matchTerms("niche n niche", [term({ id: "term-p", term: "n" })]).map((m) => m.matchedWord)).toEqual(["n"]);
  });

  it("treats a regex metacharacter in a term as literal text", () => {
    const meta = [
      term({ id: "term-cpp", term: "C++" }),
      term({ id: "term-call", term: "foo(bar)" }),
      term({ id: "term-brack", term: "[x]" }),
      term({ id: "term-dot", term: "a.b" }),
    ];
    expect(matchTerms("we write C++ and foo(bar) and [x] and a.b", meta).map((m) => m.id).sort()).toEqual([
      "term-brack",
      "term-call",
      "term-cpp",
      "term-dot",
    ]);
    // `a.b` must not match `axb`: the dot is a character, not a wildcard.
    expect(matchTerms("axb", meta)).toEqual([]);
  });

  it("agrees with the ownership rule on compatibility forms", () => {
    // The schema says these are ONE term. If the search disagreed, an entry
    // stored in the ligature form would own the word and never find it.
    const ligature = [term({ id: "term-file", term: "ﬁle" })];
    expect(matchTerms("the file is here", ligature).map((m) => m.id)).toEqual(["term-file"]);
    expect(matchTerms("the ﬁle is here", [term({ id: "term-file", term: "file" })]).map((m) => m.id)).toEqual(["term-file"]);
  });

  it("agrees with the ownership key on case, so a word the key owns is a word the search finds", () => {
    // `İ` lowers to `i` + U+0307, so the two share one key; the regex `i` flag
    // never matched across them.
    expect(matchTerms("visit i\u0307zmir today", [term({ id: "term-izmir", term: "\u0130zmir" })]).map((m) => m.id)).toEqual([
      "term-izmir",
    ]);
    // A capital sigma lowers by context: the term alone ends in a final sigma,
    // the same word before `.K` in a medial one.
    const odos = [term({ id: "term-odos", term: "\u039F\u0394\u039F\u03A3" })];
    expect(matchTerms("\u039F\u0394\u039F\u03A3.\u039A\u0391\u0399", odos).map((m) => m.id)).toEqual(["term-odos"]);
  });

  it("searches for the trimmed key, so a term or alias stored with surrounding space still finds its word", () => {
    expect(matchTerms("pen first", [term({ id: "term-pen", term: " pen " })]).map((m) => m.id)).toEqual(["term-pen"]);
    const viaAlias = matchTerms("reviewer first", [term({ id: "term-inspector", term: "inspector", aliases: [" reviewer "] })]);
    expect(viaAlias.map((m) => [m.id, m.viaAlias])).toEqual([["term-inspector", true]]);
  });

  it("does not match across a combining mark, on either side of the term", () => {
    // `q` + U+0301 has no precomposed form, so NFKC leaves the mark standing
    // inside the word.
    expect(matchTerms("q\u0301x", [term({ id: "term-q", term: "q" })])).toEqual([]);
    expect(matchTerms("q\u0301x", [term({ id: "term-x", term: "x" })])).toEqual([]);
    // Not vacuous: the same letters apart are two words.
    const both = [term({ id: "term-q", term: "q" }), term({ id: "term-x", term: "x" })];
    expect(matchTerms("q, x", both).map((m) => m.id)).toEqual(["term-q", "term-x"]);
  });

  it("does not match inside a word joined by ZWNJ, on either side of the join", () => {
    // One Persian word ("I want"): the ZWNJ keeps its prefix visually apart
    // without making it a separate word.
    const word = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
    const prefix = term({ id: "term-mi", term: "\u0645\u06CC" });
    const stem = term({ id: "term-khaham", term: "\u062E\u0648\u0627\u0647\u0645" });
    expect(matchTerms(word, [prefix, stem])).toEqual([]);
    // Not vacuous: with a space between them they are two words.
    expect(matchTerms("\u0645\u06CC \u062E\u0648\u0627\u0647\u0645", [prefix, stem]).map((m) => m.id).sort()).toEqual([
      "term-khaham",
      "term-mi",
    ]);
  });

  it("treats soft hyphen and word joiner as inside the word, and zero-width space as a boundary", () => {
    const pen = [term({ id: "term-pen", term: "pen" })];
    expect(matchTerms("pen\u00ADding", pen)).toEqual([]);
    expect(matchTerms("pen\u2060ding", pen)).toEqual([]);
    // Zero-width space separates words in scripts written without spaces.
    expect(matchTerms("pen\u200Bnext", pen).map((m) => m.id)).toEqual(["term-pen"]);
  });

  it("returns matches ordered by term, so two calls on one text agree", () => {
    const shuffled = [
      term({ id: "term-wave", term: "wave" }),
      term({ id: "term-hands", term: "hands" }),
      term({ id: "term-pen", term: "pen" }),
    ];
    expect(matchTerms("wave pen hands", shuffled).map((m) => m.term)).toEqual(["hands", "pen", "wave"]);
  });

  /**
   * The name says what this pins and no more. `matchTerms` takes no root, so
   * the ledger is out of its reach by construction, and a READ is not
   * something this assertion could see. What a pure matcher CAN do wrong is
   * act on the entries it was handed -- rename one in place, say -- which a
   * caller holding that array would then persist. The snapshot is what
   * catches that; the byte check alone never could, because nothing here
   * writes the array back.
   */
  it("is advisory: a match changes neither the ledger nor the entries it was given (G-A)", () => {
    const root = makeProject({ version: 1, terms: [term({ id: "term-pen", term: "pen", aliases: ["pen tier"] })] });
    const { doc } = glossaryCatalog.load(root);
    const before = storyBytes(root);
    const entriesBefore = structuredClone(doc.terms);

    const matches = matchTerms("the pen files the ledger", doc.terms);

    // It matched, so this is not a vacuous assertion about a call that did nothing.
    expect(matches.map((m) => m.id)).toEqual(["term-pen"]);
    // No ledger byte moved, and nothing was refused: the call returned.
    expect(storyBytes(root)).toEqual(before);
    // And the entries it read are exactly as they were handed in.
    expect(doc.terms).toEqual(entriesBefore);
  });
});

describe("checkTerms", () => {
  it("reports an unknown capability link as a structural error", () => {
    const report = checkTerms(
      [term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: ["cap-nope"] })],
      indexWith({ capabilityIds: new Set(["cap-real"]) }),
    );
    expect(report.errorIds).toEqual(["term-pen"]);
    expect(report.entries[0]?.results[0]?.code).toBe("term_unknown_capability");
    expect(report.entries[0]?.results[0]?.detail).toContain("cap-nope");
  });

  it("reports an unknown ruling as a structural error when the scan was complete", () => {
    const report = checkTerms(
      [term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: ["cap-real"], rulings: ["r-0000000000000000"] })],
      indexWith({ capabilityIds: new Set(["cap-real"]) }),
    );
    expect(report.entries[0]?.results[0]?.code).toBe("term_unknown_ruling");
    expect(report.errorIds).toEqual(["term-pen"]);
  });

  it("reports an INCOMPLETE scan as unresolved, never as unknown", () => {
    const entry = term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: ["cap-real"], rulings: ["r-0000000000000000"] });
    const incomplete = checkTerms([entry], indexWith({ capabilityIds: new Set(["cap-real"]), rulingScanIncomplete: true }));
    expect(incomplete.entries[0]?.results[0]?.code).toBe("term_check_incomplete");
    expect(incomplete.errorIds).toEqual([]);
    expect(incomplete.incompleteIds).toEqual(["term-pen"]);

    const unreadable = checkTerms(
      [entry],
      indexWith({ capabilityIds: new Set(["cap-real"]), rulingUnavailableIds: new Set(["r-0000000000000000"]) }),
    );
    expect(unreadable.entries[0]?.results[0]?.code).toBe("term_check_incomplete");
    expect(unreadable.entries[0]?.results[0]?.detail).toContain("could not be read or validated");
    expect(unreadable.errorIds).toEqual([]);
  });

  /**
   * R5, capability side. The rulings side has had this since it was written;
   * the capability side reported an unresolved id as a structural ERROR no
   * matter why it failed to resolve, which is a false accusation whenever the
   * reason is that this process could not read the file.
   *
   * The second half is the anti-vacuity partner and the reason this is two
   * assertions rather than one: the id set is EMPTY in both, so only the flag
   * differs. Without it a mutant that hard-codes the incomplete branch passes,
   * and so does one that simply never resolves anything.
   */
  it("reports an unresolved capability as unresolved when the catalog could not be READ", () => {
    const entry = term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: ["cap-real"] });

    const unreadable = checkTerms([entry], indexWith({ capabilityScanIncomplete: true }));
    expect(unreadable.entries[0]?.results[0]?.code).toBe("term_check_incomplete");
    expect(unreadable.entries[0]?.results[0]?.detail).toContain("could not be read");
    expect(unreadable.entries[0]?.results[0]?.detail).toContain("cap-real");
    expect(unreadable.errorIds).toEqual([]);
    expect(unreadable.incompleteIds).toEqual(["term-pen"]);

    // Same empty id set, catalog merely ABSENT: that IS an answer, so the
    // error stands and the entry is an error rather than unresolved.
    const absent = checkTerms([entry], indexWith({ capabilityScanIncomplete: false }));
    expect(absent.entries[0]?.results[0]?.code).toBe("term_unknown_capability");
    expect(absent.errorIds).toEqual(["term-pen"]);
    expect(absent.incompleteIds).toEqual([]);
  });

  it("flags a thin entry as a warning and never as an error", () => {
    const report = checkTerms([term({ id: "term-pen", term: "pen" })], emptyIndex);
    expect(report.errorIds).toEqual([]);
    expect(report.thinIds).toEqual(["term-pen"]);
    expect(report.entries[0]?.results[0]?.detail).toContain("no distinction");
    expect(report.entries[0]?.results[0]?.detail).toContain("no capability link");
  });

  it("does not flag an entry that has both halves", () => {
    const report = checkTerms(
      [term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: ["cap-real"] })],
      indexWith({ capabilityIds: new Set(["cap-real"]) }),
    );
    expect(report.thinIds).toEqual([]);
    expect(report.entries[0]?.results).toEqual([]);
  });

  it("flags an entry whose capabilities array is present but empty", () => {
    const report = checkTerms([term({ id: "term-pen", term: "pen", distinction: "not hands", capabilities: [] })], emptyIndex);
    expect(report.thinIds).toEqual(["term-pen"]);
    expect(report.entries[0]?.results[0]?.detail).toContain("no capability link");
    expect(report.entries[0]?.results[0]?.detail).not.toContain("no distinction");
  });
});

describe("buildTermReferenceIndex", () => {
  it("carries the capability ids the caller holds and scans the rulings itself", () => {
    const index = buildTermReferenceIndex(makeProject(), { ids: ["cap-a", "cap-b"], incomplete: false });
    expect([...index.capabilityIds].sort()).toEqual(["cap-a", "cap-b"]);
    expect(index.capabilityScanIncomplete).toBe(false);
    expect(index.rulingIds.size).toBe(0);
  });

  it("carries the caller's incomplete flag through rather than inferring it from an empty set", () => {
    const index = buildTermReferenceIndex(makeProject(), { ids: [], incomplete: true });
    expect(index.capabilityIds.size).toBe(0);
    expect(index.capabilityScanIncomplete).toBe(true);
  });
});

describe("termDigest (G-C)", () => {
  function many(count: number, core: number): Term[] {
    return Array.from({ length: count }, (_, i) =>
      term({ id: `term-t${String(i).padStart(3, "0")}`, term: `t${String(i).padStart(3, "0")}`, core: i < core ? true : undefined }),
    );
  }

  it("returns every name, sorted by term, at or under the cap", () => {
    const digest = termDigest(many(TERM_DIGEST_CAP, 3));
    expect(digest.returned).toBe(TERM_DIGEST_CAP);
    expect(digest.total).toBe(TERM_DIGEST_CAP);
    expect(digest.core).toBe(3);
    expect(digest.omittedCore).toBe(0);
    expect(digest.omittedNonCore).toBe(0);
    expect([...digest.names]).toEqual([...digest.names].sort());
  });

  /**
   * `many()` mints ids and terms in the same order, so it cannot tell a sort
   * by term from a sort by id -- and entries are STORED sorted by id, which is
   * exactly the order a lazy digest would inherit. Here the two orders are
   * opposite, so only a sort by term passes.
   */
  it("sorts by the TERM, not the id the entries are stored in", () => {
    const digest = termDigest([term({ id: "term-a", term: "zeta" }), term({ id: "term-z", term: "alpha" })]);
    expect([...digest.names]).toEqual(["alpha", "zeta"]);
  });

  it("over the cap, returns ONLY the core names and counts what it left out", () => {
    const digest = termDigest(many(TERM_DIGEST_CAP + 1, 3));
    expect(digest.returned).toBe(3);
    expect(digest.names).toEqual(["t000", "t001", "t002"]);
    expect(digest.total).toBe(TERM_DIGEST_CAP + 1);
    expect(digest.omittedCore).toBe(0);
    expect(digest.omittedNonCore).toBe(TERM_DIGEST_CAP - 2);
  });

  it("when core itself exceeds the cap, returns the first cap core names and says how many core were left", () => {
    // Handed in reversed, so "first" can only mean first BY TERM: the input's
    // own order would put the name that should be dropped at the front.
    const digest = termDigest(many(TERM_DIGEST_CAP + 1, TERM_DIGEST_CAP + 1).reverse());
    const expected = Array.from({ length: TERM_DIGEST_CAP }, (_, i) => `t${String(i).padStart(3, "0")}`);
    expect(digest.names).toEqual(expected);
    expect(digest.names).not.toContain(`t${String(TERM_DIGEST_CAP).padStart(3, "0")}`);
    expect(digest.returned).toBe(TERM_DIGEST_CAP);
    expect(digest.core).toBe(TERM_DIGEST_CAP + 1);
    expect(digest.omittedCore).toBe(1);
    expect(digest.omittedNonCore).toBe(0);
  });

  it("over the cap with no core entry at all, returns nothing and says so in the counts", () => {
    const digest = termDigest(many(TERM_DIGEST_CAP + 1, 0));
    expect(digest.names).toEqual([]);
    expect(digest.returned).toBe(0);
    expect(digest.omittedNonCore).toBe(TERM_DIGEST_CAP + 1);
  });

  it("returns names raw, so a JSON consumer gets the stored value", () => {
    const digest = termDigest([term({ id: "term-x", term: "a\u0007b" })]);
    expect(digest.names).toEqual(["a\u0007b"]);
  });
});
