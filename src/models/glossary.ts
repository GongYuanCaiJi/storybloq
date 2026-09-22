import { z } from "zod";
import { RulingIdSchema } from "./types.js";
import { CapabilityIdSchema, TermIdSchema } from "./capability.js";

/**
 * T-524: the glossary. One entry answers "what does this word mean here, and
 * what is it NOT" -- the second half being the one a definition alone never
 * carries and the one terminology drift is made of.
 *
 * ADVISORY, AND THAT IS A SCHEMA-LEVEL FACT AS MUCH AS A CODE ONE (G-A).
 * Nothing in this file is a rename rule, a lint rule or a refusal. An entry is
 * something a brief SHOWS a reader; no code path may act on a term match. The
 * fields exist to be printed and linked, not to be enforced.
 *
 * The ids, the slug and the catalog plumbing are IMPORTED from
 * `./capability.js` rather than restated. Two spellings of one identity rule
 * is the defect class T-523 hit repeatedly, and a `term-` slug that drifted
 * between the file that MINTS the id and the file that REFERENCES it (a
 * capability's `terms`) would let an id pass one side and fail the other.
 *
 * `.passthrough()` for the same reason as every other catalog-adjacent model:
 * unknown fields survive a parse/rewrite round trip, so an older CLI never
 * silently strips a newer field out of a tracked, shared file.
 */

/**
 * The form two terms are compared in when deciding whether they are the SAME
 * term. Three steps, each closing a different way two entries could both claim
 * one word:
 *
 *  - NFKC, because the compatibility forms are the ones a reader cannot tell
 *    apart. `ﬁle` (U+FB01 ligature) and `file` are one word on the page and
 *    two strings in the file; owning them separately would put the same word
 *    in two entries with two definitions, which is precisely what a glossary
 *    exists to prevent.
 *  - lower case, because `Pen` and `pen` are one term and the matcher is
 *    case-insensitive: leaving them as two owners would let a match report two
 *    entries for one word. Then final sigma folded to medial sigma (U+03C2 to
 *    U+03C3), because `toLowerCase` picks the sigma form from CONTEXT:
 *    `ΟΔΟΣ` lowers to a final sigma and `ΟΔΟΣ.ΚΑΙ` to a medial one, so a key
 *    that kept both forms would own a word the search finds or misses
 *    depending on the punctuation after it. Unicode case folding makes the
 *    same mapping, so the two sigmas are one owner.
 *  - trim, because leading or trailing space is invisible in a JSON string and
 *    a term that differs from another only by it is a typo, never a decision.
 *
 * Deliberately NOT applied: internal whitespace collapsing. `plan pin guard`
 * and `plan  pin guard` stay distinct, because collapsing would make the
 * stored term and the matched text disagree -- the matcher searches for the
 * literal term, so a term normalized in a way the search is not would own a
 * word it can never find.
 */
export function normalizeTermKey(value: string): string {
  return foldTermText(value).trim();
}

/**
 * The key without the trim, and the ONLY fold the matcher applies to the text
 * it searches. One function for both is the agreement: a word the key says an
 * entry owns is a word the search can find, because the search compares the
 * two in exactly this form. With the sigma fold, `toLowerCase` has no
 * context-dependent mapping left, so folding a whole text and folding one word
 * of it agree.
 */
export function foldTermText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\u03C2/g, "\u03C3");
}

/**
 * A term or alias as written. The bound is the useful part: a term is a WORD
 * or a short phrase, and the matcher searches for it literally in an item's
 * title and description. Something longer than this is prose, and prose can
 * never be matched by a whole-word search, so it would be a permanently inert
 * entry -- valid, accepted, and silently useless, the state A10.2 refused for
 * entry points and this refuses here for the same reason.
 */
const TERM_TEXT_MAX = 120;

/**
 * Whether a term has anything a reader could see. NFKC and `trim` are not
 * enough on their own: zero-width space, zero-width joiner and non-joiner,
 * word joiner and soft hyphen are none of them whitespace, and neither are the
 * C0 and C1 control characters (NUL, BEL, ESC, U+009B), so a term made only of
 * them survives both and would be an entry with no visible name.
 *
 * `Default_Ignorable_Code_Point` and `Cc` are two classes because neither
 * contains the other: the controls are not default-ignorable, they are simply
 * not printable.
 *
 * Both are stripped HERE, for this check, and NOT in `normalizeTermKey`, for
 * two reasons. It is only-invisible that is refused, never contains-invisible:
 * ZWNJ joins letters inside ordinary Persian and Indic words, so refusing a
 * term that merely carries one would refuse real vocabulary. And ownership
 * must keep agreeing with the matcher, which folds the text it searches
 * exactly as the key is folded (`foldTermText`); stripping these from the key
 * but not from the text would let a term own a spelling it can never find.
 */
function hasVisibleContent(value: string): boolean {
  return normalizeTermKey(value).replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "").trim().length > 0;
}

const TermTextSchema = z
  .string()
  .min(1, "A term cannot be empty")
  .max(TERM_TEXT_MAX, `A term is a word or short phrase, not prose: keep it under ${TERM_TEXT_MAX} characters`)
  .refine(
    hasVisibleContent,
    "A term must have visible content: a term of only whitespace or invisible characters can never be matched",
  );

/**
 * One sentence, and the bound says so rather than trusting it. A glossary
 * entry that grows into paragraphs has become architecture prose, which the
 * catalog rule puts in a note or a ruling and reaches from here by id. The
 * bound is what keeps the digest and the PLAN brief affordable: both render
 * definitions inline.
 */
const DEFINITION_MAX = 400;
const DISTINCTION_MAX = 400;

export const TermSchema = z
  .object({
    id: TermIdSchema,
    term: TermTextSchema,
    aliases: z.array(TermTextSchema).optional(),
    definition: z
      .string()
      .min(1, "A term needs a definition")
      .max(DEFINITION_MAX, `A definition is one sentence: keep it under ${DEFINITION_MAX} characters and put the reasoning in a note`),
    /**
     * What the term is NOT, or what it differs from. Optional in the schema
     * and flagged as thin by `term check`, which is the right split: a term
     * filed mid-flight with only a definition is better in the ledger than
     * held out of it, and the flag is what stops it staying that way.
     */
    distinction: z
      .string()
      .min(1, "A distinction cannot be empty: omit the field instead")
      .max(DISTINCTION_MAX, `A distinction is one sentence: keep it under ${DISTINCTION_MAX} characters`)
      .optional(),
    capabilities: z.array(CapabilityIdSchema).optional(),
    rulings: z.array(RulingIdSchema).optional(),
    /**
     * Makes the term ELIGIBLE for the digest when the glossary is over the cap
     * (G-C): above it only core entries load, still no more than the cap of
     * them, and any beyond that are counted in `omittedCore`. It is a claim
     * about what a session cannot work without, so it is set deliberately and
     * never derived.
     */
    core: z.boolean().optional(),
    addedBy: z.string().min(1).optional(),
    /**
     * Full ISO 8601, stricter than the ledger's `TimestampSchema`, on purpose.
     * This file is hand-editable and the field's consumers display and order
     * by it, so an unparseable value would not fail, it would sort somewhere
     * arbitrary. A refusal at the write is cheaper than a listing that is
     * quietly in the wrong order.
     */
    updatedAt: z.string().datetime({ offset: true, message: "updatedAt must be an ISO 8601 timestamp" }),
  })
  .passthrough()
  /**
   * WITHIN one entry, a name may appear once. An alias repeating its own term,
   * or repeating another alias, is the AMBIGUOUS form again: either a harmless
   * repeat or a typo for a different word, and the text cannot say which.
   * Accepting it would resolve it in the direction that hides the typo, and a
   * typo'd alias is a word the glossary claims to cover and never matches.
   *
   * Compared in the normalized form, so `Pen` beside `pen` is caught. The
   * message names the value, which at write time is the author's own input;
   * at load time it never reaches the caller, because the catalog load
   * diagnostic reports the issue's location and code only.
   */
  .superRefine((entry, ctx) => {
    const owner = new Map<string, string>([[normalizeTermKey(entry.term), "term"]]);
    (entry.aliases ?? []).forEach((alias, index) => {
      const key = normalizeTermKey(alias);
      const first = owner.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aliases", index],
          message: `Alias ${alias} repeats this entry's ${first}; name each form once`,
        });
        return;
      }
      owner.set(key, `alias ${index}`);
    });
  });

/**
 * The file document. `version` is a literal rather than a number so a future
 * version 2 file fails the parse and surfaces as a CatalogLoadError, instead
 * of passing through and being rewritten by an older CLI that does not
 * understand it. Same reasoning as the capability catalog, and the same shape,
 * because they are one mechanism.
 */
export const GlossaryCatalogSchema = z
  .object({
    version: z.literal(1),
    terms: z.array(TermSchema).default([]),
  })
  .passthrough()
  /**
   * The two document invariants, checked HERE rather than through a separate
   * `problems[]` channel, because the shipped `defineCatalog` runs this schema
   * on load AND on every write: putting them in the schema is what makes a
   * collision impossible to introduce by either route, including a hand edit.
   *
   * 1. Ids are unique. Everything downstream keys by id, so a duplicate does
   *    not fail loudly, it MASKS: `get` and `update` select the first match
   *    while `check` reports on the second.
   * 2. Every normalized term and alias is owned by exactly one entry, term-to-
   *    alias collisions included. This is the invariant the glossary exists
   *    for: two entries claiming one word means the matcher returns two
   *    definitions for it, and a reader shown two canonical meanings has
   *    learned nothing. It is also why the check is cross-field rather than
   *    per-field -- the collision that matters most is one entry's alias
   *    against another entry's term, which no field-local rule can see.
   *
   * A MERGE can produce a document neither side wrote, and this refuses it at
   * the next load with a location rather than a resolvable conflict record.
   * Making that case resolvable is T-529's `invariant` record; it is not
   * missing validation here.
   */
  .superRefine((doc, ctx) => {
    const ids = new Map<string, number>();
    const names = new Map<string, { index: number; field: string }>();
    doc.terms.forEach((entry, index) => {
      const firstId = ids.get(entry.id);
      if (firstId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terms", index, "id"],
          message: `Duplicate term id ${entry.id} (first at terms.${firstId})`,
        });
      } else {
        ids.set(entry.id, index);
      }

      const claims: Array<{ value: string; path: (string | number)[]; field: string }> = [
        { value: entry.term, path: ["terms", index, "term"], field: "term" },
      ];
      (entry.aliases ?? []).forEach((alias, aliasIndex) => {
        claims.push({ value: alias, path: ["terms", index, "aliases", aliasIndex], field: `alias ${alias}` });
      });
      for (const claim of claims) {
        const key = normalizeTermKey(claim.value);
        const owner = names.get(key);
        if (owner !== undefined && owner.index !== index) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: claim.path,
            message: `${claim.value} is already owned by terms.${owner.index} (its ${owner.field}); one word belongs to one entry`,
          });
          continue;
        }
        if (owner === undefined) names.set(key, { index, field: claim.field });
      }
    });
  });

export type Term = z.infer<typeof TermSchema>;
export type GlossaryCatalog = z.infer<typeof GlossaryCatalogSchema>;
