import { describe, it, expect } from "vitest";
import { TermSchema, GlossaryCatalogSchema, normalizeTermKey } from "../../src/models/glossary.js";

function baseTerm(overrides: Record<string, unknown> = {}) {
  return {
    id: "term-pen",
    term: "pen",
    definition: "The session model that owns the judgement gates and files the ledger.",
    updatedAt: "2026-09-21T18:44:42.000Z",
    ...overrides,
  };
}

describe("normalizeTermKey", () => {
  it("folds the three differences that make two spellings one term", () => {
    expect(normalizeTermKey("  Pen ")).toBe("pen");
    // NFKC: the ligature and the two letters are one word on the page.
    expect(normalizeTermKey("ﬁle")).toBe("file");
    expect(normalizeTermKey("ﬁle")).toBe(normalizeTermKey("FILE"));
  });

  it("folds the two sigma forms into one, because lower-casing picks between them by context", () => {
    expect(normalizeTermKey("\u03C2")).toBe(normalizeTermKey("\u03C3"));
    // One word lowered in two contexts: alone its capital sigma becomes final,
    // before `.K` it becomes medial. Both must be one key.
    expect(normalizeTermKey("\u039F\u0394\u039F\u03A3")).toBe(normalizeTermKey("\u03BF\u03B4\u03BF\u03C3"));
  });

  it("keeps internal whitespace, because the matcher searches for the literal term", () => {
    // Collapsing here would let an entry own a phrase the search can never
    // find, which is the inert-but-valid state the rules exist to refuse.
    expect(normalizeTermKey("plan  pin guard")).toBe("plan  pin guard");
    expect(normalizeTermKey("plan pin guard")).not.toBe(normalizeTermKey("plan  pin guard"));
  });
});

describe("TermSchema", () => {
  it("parses a minimal entry and leaves every optional field absent", () => {
    const result = TermSchema.safeParse(baseTerm());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.distinction).toBeUndefined();
    expect(result.data.capabilities).toBeUndefined();
    expect(result.data.core).toBeUndefined();
  });

  it("round trips through JSON without losing or inventing a field", () => {
    // Every optional field is present, so a field the parse drops shows. The
    // aliases are deliberately NOT in sorted order: an input already in the
    // order a parse might impose cannot show that parse reordering it. A field
    // the parse INVENTS is the minimal-entry test's job, not this one's.
    const input = baseTerm({
      aliases: ["the pen", "pen tier"],
      distinction: "Not the inspector, which reviews, and not hands, which implement.",
      capabilities: ["cap-orchestrate"],
      rulings: ["r-8bjvtgh0hphetpw0"],
      core: true,
      addedBy: "cpm-a7",
    });
    const parsed = TermSchema.parse(input);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

  it("keeps an unknown field through a parse and rewrite, so an older CLI cannot strip a newer one", () => {
    const input = baseTerm({ futureField: { shape: ["anything"] } });
    const parsed = TermSchema.parse(input);
    expect((parsed as Record<string, unknown>).futureField).toEqual({ shape: ["anything"] });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

  it("refuses an id that is not term-<slug>", () => {
    expect(TermSchema.safeParse(baseTerm({ id: "cap-pen" })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ id: "term-Pen" })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ id: "pen" })).success).toBe(false);
  });

  it("refuses a term that normalizes to nothing, which could never be matched", () => {
    const blank = TermSchema.safeParse(baseTerm({ term: "   " }));
    expect(blank.success).toBe(false);
    if (blank.success) return;
    expect(blank.error.issues.some((i) => i.message.includes("visible content"))).toBe(true);
  });

  /**
   * NFKC and `trim` both leave these alone: none of them is whitespace. Each
   * is its own case so a fix that happens to catch one (a hard-coded U+200B,
   * say) cannot pass for all of them. The rows come in two classes because the
   * predicate strips two, default-ignorables and controls, and a fix covering
   * only one class fails the other's rows. The two mixture rows are
   * whitespace around each class, which `trim` half-cleans.
   */
  it.each([
    ["zero-width space", "\u200B"],
    ["zero-width joiner", "\u200D"],
    ["zero-width non-joiner", "\u200C"],
    ["word joiner", "\u2060"],
    ["soft hyphen", "\u00AD"],
    ["whitespace around an invisible", " \u200B\u200D "],
    ["NUL", "\u0000"],
    ["BEL", "\u0007"],
    ["the C1 control-sequence introducer", "\u009B"],
    ["whitespace around a control", " \u0007 "],
  ])("refuses a term of only %s, which has no visible name", (_label, value) => {
    const term = TermSchema.safeParse(baseTerm({ term: value }));
    expect(term.success).toBe(false);
    if (term.success) return;
    expect(term.error.issues.some((i) => i.message.includes("visible content"))).toBe(true);
  });

  it.each([
    ["invisible characters", "\u200B\u2060"],
    ["control characters", "\u0000\u0007"],
  ])("refuses an alias of only %s, which the same rule covers", (_label, value) => {
    const alias = TermSchema.safeParse(baseTerm({ aliases: [value] }));
    expect(alias.success).toBe(false);
    if (alias.success) return;
    expect(alias.error.issues.some((i) => i.path.join(".") === "aliases.0")).toBe(true);
  });

  /**
   * The boundary, and the reason the rule is only-invisible rather than
   * contains-invisible: ZWNJ is a real letter-joiner inside ordinary Persian
   * words. A stricter rule would pass every case above and refuse this one.
   */
  it("accepts a real word that CONTAINS a joiner, because the rule is only-invisible", () => {
    const persian = TermSchema.safeParse(baseTerm({ term: "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645" }));
    expect(persian.success).toBe(true);
  });

  it("refuses prose in the term, the definition and the distinction", () => {
    expect(TermSchema.safeParse(baseTerm({ term: "x".repeat(121) })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ term: "x".repeat(120) })).success).toBe(true);
    expect(TermSchema.safeParse(baseTerm({ definition: "d".repeat(401) })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ distinction: "d".repeat(401) })).success).toBe(false);
  });

  it("refuses an empty distinction rather than storing a field that says nothing", () => {
    const result = TermSchema.safeParse(baseTerm({ distinction: "" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("omit the field instead");
  });

  it("refuses an alias that repeats its own term, in the normalized form", () => {
    const result = TermSchema.safeParse(baseTerm({ aliases: ["PEN"] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("repeats this entry's term");
    expect(result.error.issues[0]?.path).toEqual(["aliases", 0]);
  });

  it("refuses one alias repeating another, and names which one", () => {
    const result = TermSchema.safeParse(baseTerm({ aliases: ["the pen", "The Pen"] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("repeats this entry's alias 0");
    expect(result.error.issues[0]?.path).toEqual(["aliases", 1]);
  });

  it("requires an ISO timestamp for updatedAt, so a listing cannot sort somewhere arbitrary", () => {
    expect(TermSchema.safeParse(baseTerm({ updatedAt: "2026-09-21" })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ updatedAt: "yesterday" })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ updatedAt: "2026-09-21T18:44:42+07:00" })).success).toBe(true);
  });

  it("refuses a capability link that is not a cap- id and a ruling link that is not an r- id", () => {
    expect(TermSchema.safeParse(baseTerm({ capabilities: ["term-pen"] })).success).toBe(false);
    expect(TermSchema.safeParse(baseTerm({ rulings: ["cap-pen"] })).success).toBe(false);
  });
});

describe("GlossaryCatalogSchema", () => {
  it("defaults an absent terms array and refuses a version it does not understand", () => {
    expect(GlossaryCatalogSchema.parse({ version: 1 }).terms).toEqual([]);
    expect(GlossaryCatalogSchema.safeParse({ version: 2, terms: [] }).success).toBe(false);
  });

  it("refuses a duplicate id, which would otherwise MASK rather than fail", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm(), baseTerm({ term: "hands" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("Duplicate term id term-pen (first at terms.0)");
  });

  it("refuses two entries owning one word, and names the owner", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm(), baseTerm({ id: "term-pen-tier", term: "Pen" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0 (its term)");
    expect(result.error.issues[0]?.path).toEqual(["terms", 1, "term"]);
  });

  it("refuses one entry's ALIAS colliding with another entry's TERM, which no field-local rule can see", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm(), baseTerm({ id: "term-hands", term: "hands", aliases: ["the pen", "PEN"] })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["terms", 1, "aliases", 1]);
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0 (its term)");
  });

  /**
   * The other direction: the EARLIER entry owns the word through an alias. An
   * ownership map that recorded only terms would pass every case above and
   * let a later entry claim an alias as its own.
   */
  it("refuses a later TERM claiming an earlier entry's ALIAS, and names the alias as the owner", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm({ aliases: ["the pen"] }), baseTerm({ id: "term-quill", term: "The Pen" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["terms", 1, "term"]);
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0 (its alias the pen)");
  });

  it("refuses a later ALIAS claiming an earlier entry's ALIAS", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm({ aliases: ["the pen"] }), baseTerm({ id: "term-hands", term: "hands", aliases: ["THE PEN"] })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["terms", 1, "aliases", 0]);
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0 (its alias the pen)");
  });

  it("refuses a collision that only the compatibility fold reveals", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm({ id: "term-file", term: "file" }), baseTerm({ id: "term-ligature", term: "ﬁle" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0");
  });

  it("refuses the two sigma forms as two owners, which the matcher cannot tell apart", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm({ id: "term-medial", term: "\u03C3" }), baseTerm({ id: "term-final", term: "\u03C2" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("already owned by terms.0");
  });

  it("accepts two entries whose terms merely share a prefix", () => {
    const result = GlossaryCatalogSchema.safeParse({
      version: 1,
      terms: [baseTerm(), baseTerm({ id: "term-pending", term: "pending" })],
    });
    expect(result.success).toBe(true);
  });

  it("keeps an unknown document-level field", () => {
    const parsed = GlossaryCatalogSchema.parse({ version: 1, terms: [], futureTop: 7 });
    expect((parsed as Record<string, unknown>).futureTop).toBe(7);
  });
});
