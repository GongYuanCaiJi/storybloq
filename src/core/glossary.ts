/**
 * T-524: the glossary, the second instantiation of the shared catalog
 * mechanism.
 *
 * ADVISORY, WHICH IS THE ONE RULE THIS FILE EXISTS TO KEEP (G-A). Nothing here
 * renames, rewrites or refuses on a term. `matchTerms` is a pure function of
 * its text argument: it reads no file, holds no lock, writes nothing, and
 * returns what a brief may SHOW a reader. If a future caller ever wants to act
 * on a match -- refuse a title, rewrite a description, fail a check -- that is
 * out of contract, and the boundary test pins it.
 *
 * The catalog INSTANCE lives here rather than beside the CLI surface, unlike
 * `capabilityCatalog`. That asymmetry is forced and worth stating: the
 * capability check resolves a capability's `terms` against the glossary, so
 * `src/core/capability.ts` must be able to load this file, and a core module
 * reaching into `src/cli/` for it would invert the dependency.
 */

import { defineCatalog, type Catalog } from "./catalog.js";
import { loadRulingsSafe, type LoadRulingsResult } from "./ruling-loader.js";
import type { LedgerSnapshot } from "./ledger-snapshot.js";
import { hasPendingNote } from "../models/capability.js";
import {
  GlossaryCatalogSchema,
  foldTermText,
  normalizeTermKey,
  type GlossaryCatalog,
  type Term,
} from "../models/glossary.js";

/** The one glossary this project has. */
export const glossaryCatalog: Catalog<GlossaryCatalog> = defineCatalog<GlossaryCatalog>({
  file: "glossary.json",
  key: "terms",
  schema: GlossaryCatalogSchema,
  empty: () => ({ version: 1, terms: [] }),
});

/**
 * Entries are stored sorted by id, so a diff of this file shows what changed
 * rather than where an append landed. Display order is a separate question and
 * is by `term`: storage order serves git, display order serves a reader.
 */
export function sortTerms(entries: readonly Term[]): Term[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- check ---

export type TermCheckClass = "structural" | "thin" | "incomplete";

export type TermCheckCode =
  | "term_unknown_capability"
  | "term_unknown_ruling"
  | "term_check_incomplete"
  | "term_thin";

export interface TermCheckResult {
  readonly code: TermCheckCode;
  readonly cls: TermCheckClass;
  /** Human-readable and already safe to print: every unconstrained value is sanitized here. */
  readonly detail: string;
}

export interface TermCheckEntry {
  readonly id: string;
  readonly results: readonly TermCheckResult[];
  /**
   * T-526 (3.7): `review` when a pending note is set or a structural or
   * incomplete result stands; thin alone does not flip it, thin being a
   * warning everywhere.
   */
  readonly effectiveStatus: "current" | "review";
  readonly pendingNote: string | null;
}

export interface TermCheckReport {
  readonly entries: readonly TermCheckEntry[];
  /** Ids with at least one structural result. `validate` fails on these. */
  readonly errorIds: readonly string[];
  /** Ids flagged thin. A warning everywhere: a thin term is still a term. */
  readonly thinIds: readonly string[];
  /** Ids carrying a reference this process could not resolve either way. */
  readonly incompleteIds: readonly string[];
  /** Ids with a pending note set. */
  readonly pendingIds: readonly string[];
  /** Present when the index came from a ledger snapshot (see `LedgerSnapshot.filesystemChecks`). */
  readonly filesystemChecks?: "working-tree";
}

export interface TermReferenceIndex {
  readonly capabilityIds: ReadonlySet<string>;
  /**
   * True when the capability catalog EXISTS but could not be read, so the id
   * set is empty for a reason that is not "there are no capabilities".
   *
   * Same taint doctrine as `rulingScanIncomplete` (R5), and the asymmetry is
   * the whole point: an ABSENT catalog is a determinate answer, so an id that
   * names a capability is genuinely unknown and stays a structural error. An
   * UNREADABLE one is not an answer at all, and calling its ids unknown would
   * be a false accusation sourced from a file this process failed to read.
   */
  readonly capabilityScanIncomplete: boolean;
  readonly rulingIds: ReadonlySet<string>;
  /**
   * True when the rulings directory could not be scanned completely. An
   * incomplete scan cannot support the claim "this id does not exist", so a
   * reference it fails to find is reported as unresolved rather than unknown.
   * Same taint doctrine the capability check applies (R5); do not "fix" it
   * into an error, which would be a false accusation sourced from a directory
   * this process failed to read.
   */
  readonly rulingScanIncomplete: boolean;
  /** Rulings whose file exists but could not be read or validated. */
  readonly rulingUnavailableIds: ReadonlySet<string>;
  /** True when the index was built from a ledger snapshot rather than the working tree. */
  readonly fromSnapshot?: boolean;
}

function indexFrom(capabilities: CapabilityScan, scan: LoadRulingsResult): TermReferenceIndex {
  return {
    capabilityIds: new Set(capabilities.ids),
    capabilityScanIncomplete: capabilities.incomplete,
    rulingIds: new Set(scan.rulings.map((r) => r.id)),
    rulingScanIncomplete: scan.scanCompleteness !== "complete" || scan.hasUnrecoverableEntries,
    rulingUnavailableIds: new Set(scan.unavailableIds),
  };
}

/**
 * T-526 (3.2): the same index, resolved against the ledger at a snapshot's
 * commit. An ABSENT capability catalog at that commit is a determinate empty
 * set, as it is on the working tree; an unreadable one or an unavailable
 * snapshot is taint.
 */
export function buildTermReferenceIndexFromSnapshot(snapshot: LedgerSnapshot): TermReferenceIndex {
  const caps = snapshot.capabilities();
  const capabilities: CapabilityScan =
    caps.kind === "ok"
      ? { ids: caps.entries.map((c) => c.id), incomplete: false }
      : { ids: [], incomplete: caps.kind !== "absent" };
  return { ...indexFrom(capabilities, snapshot.rulingsScan()), fromSnapshot: true };
}

/**
 * Builds the index a check needs. The CAPABILITY scan comes from the caller
 * because the capability catalog is instantiated beside its own CLI surface
 * and `core` must not import `cli`; the rulings are scanned here because every
 * caller would otherwise scan them identically.
 *
 * The capability side is a `{ ids, incomplete }` pair rather than a bare
 * iterable so a caller cannot pass an empty set that silently means "could not
 * read the file". That distinction is not recoverable downstream, and losing
 * it turns an unreadable catalog into a structural error against every term
 * that links one.
 */
export function buildTermReferenceIndex(root: string, capabilities: CapabilityScan): TermReferenceIndex {
  return indexFrom(capabilities, loadRulingsSafe(root));
}

/** The capability id set plus whether the read that produced it actually succeeded. */
export interface CapabilityScan {
  readonly ids: Iterable<string>;
  readonly incomplete: boolean;
}

function result(code: TermCheckCode, cls: TermCheckClass, detail: string): TermCheckResult {
  return { code, cls, detail };
}

/**
 * THIN is a warning and never an error, and the split is the point. A term
 * filed mid-flight with a definition and nothing else is better in the ledger
 * than held out of it; the flag is what stops it staying that way. An entry is
 * thin when it has no `distinction` (the half that carries what the term is
 * NOT, which is where drift actually happens) or no `capabilities` link (the
 * half that says where the word lives in the code).
 */
function thinReasons(entry: Term): string[] {
  const missing: string[] = [];
  if (entry.distinction === undefined) missing.push("no distinction (what it is NOT, or what it differs from)");
  if ((entry.capabilities ?? []).length === 0) missing.push("no capability link");
  return missing;
}

export function checkTerms(entries: readonly Term[], index: TermReferenceIndex): TermCheckReport {
  const checked: TermCheckEntry[] = [];
  const errorIds: string[] = [];
  const thinIds: string[] = [];
  const incompleteIds: string[] = [];
  const pendingIds: string[] = [];

  for (const entry of entries) {
    const results: TermCheckResult[] = [];

    for (const id of entry.capabilities ?? []) {
      if (index.capabilityIds.has(id)) continue;
      if (index.capabilityScanIncomplete) {
        results.push(
          result("term_check_incomplete", "incomplete", `capability ${id} could not be resolved: the capability catalog could not be read`),
        );
        continue;
      }
      results.push(result("term_unknown_capability", "structural", `unknown capability: ${id}`));
    }

    for (const id of entry.rulings ?? []) {
      if (index.rulingIds.has(id)) continue;
      if (index.rulingUnavailableIds.has(id)) {
        results.push(
          result("term_check_incomplete", "incomplete", `ruling ${id} exists but could not be read or validated, so the reference was not checked`),
        );
        continue;
      }
      if (index.rulingScanIncomplete) {
        results.push(result("term_check_incomplete", "incomplete", `ruling ${id} could not be resolved: the rulings scan was incomplete`));
        continue;
      }
      results.push(result("term_unknown_ruling", "structural", `unknown ruling: ${id}`));
    }

    const missing = thinReasons(entry);
    if (missing.length > 0) {
      results.push(result("term_thin", "thin", `thin entry: ${missing.join("; ")}`));
    }

    if (results.some((r) => r.cls === "structural")) errorIds.push(entry.id);
    if (results.some((r) => r.cls === "thin")) thinIds.push(entry.id);
    if (results.some((r) => r.cls === "incomplete")) incompleteIds.push(entry.id);
    const pending = hasPendingNote(entry);
    if (pending) pendingIds.push(entry.id);
    const flagged = pending || results.some((r) => r.cls === "structural" || r.cls === "incomplete");
    checked.push({ id: entry.id, results, effectiveStatus: flagged ? "review" : "current", pendingNote: pending ? entry.pendingNote! : null });
  }

  return {
    entries: checked,
    errorIds,
    thinIds,
    incompleteIds,
    pendingIds,
    ...(index.fromSnapshot === true && { filesystemChecks: "working-tree" as const }),
  };
}

// --- match ---

export interface TermMatch {
  readonly id: string;
  readonly term: string;
  /**
   * The text that matched, in the folded form the search ran in (NFKC, lower
   * case, one sigma). It is evidence for a reader, not a slice of the caller's
   * original string: the fold can change a string's length, so an offset back
   * into the input would be wrong more often than it was right.
   */
  readonly matchedWord: string;
  /** True when an alias matched rather than the canonical term. */
  readonly viaAlias: boolean;
}

/**
 * The characters a word continues through: a term is only found between two
 * characters OUTSIDE this set. `\b` is ASCII-only in JavaScript, so it would
 * fire in the middle of any word carrying an accent or a non-Latin script;
 * this is the same idea over Unicode.
 *
 * Letters, numbers and the underscore, plus what Unicode's word-boundary rules
 * (UAX #29, WB4) hold inside the word they sit in: combining marks, which NFKC
 * leaves uncomposed when a letter has no precomposed form (`q` + U+0301); the
 * two join controls, ZWNJ and ZWJ, which sit inside ordinary Persian and Indic
 * words; and soft hyphen and word joiner, which are hints INSIDE a word.
 * Without them a term matches the front half of a word and reports a match
 * that is not there.
 *
 * Zero-width space is deliberately NOT in the set: it is the word separator in
 * scripts written without spaces, so it has to stay a boundary.
 */
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}\\p{Join_Control}_\\u00AD\\u2060]";
const BEFORE = `(?<!${WORD_CHAR})`;
const AFTER = `(?!${WORD_CHAR})`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Both sides go through the ownership rule's own fold and the search is then
 * EXACT (`u`, no `i`), which is what keeps the matcher honest with ownership.
 * The regex `i` flag folds case by its own table, which disagrees with
 * `toLowerCase` in both directions: `İ` and `i` + U+0307 share one key and the
 * flag does not match across them, while the flag matches the two sigmas that
 * only the sigma fold makes one key. Comparing in the key's own form leaves no
 * second table to disagree with. The needle is the full key, trim included, so
 * a term stored with stray surrounding space still finds the word it owns; the
 * ligature form finds the plain word for the same reason, NFKC being part of
 * the fold.
 */
function matchesWholeWord(haystack: string, needle: string): string | null {
  const re = new RegExp(`${BEFORE}${escapeRegex(needle)}${AFTER}`, "u");
  const found = re.exec(haystack);
  return found ? found[0] : null;
}

/**
 * Which glossary terms appear in a piece of text. WHOLE-WORD and
 * case-insensitive: "Pen" matches, "pending" does not, which is the whole
 * reason the matching rule is written out rather than left to `includes`.
 *
 * AT MOST ONE MATCH PER ENTRY, canonical term first, then aliases in order.
 * An entry whose term and alias both appear is still one term the reader needs
 * defined once; returning it twice would put it in the brief twice.
 *
 * Callers pass the item's title and description and NOTHING ELSE (G-C): the
 * transcript is not matched, because a term mentioned in passing in a
 * conversation is not evidence the item is about it.
 *
 * Results are ordered by canonical term so two calls on one text agree.
 */
export function matchTerms(text: string, entries: readonly Term[]): TermMatch[] {
  const haystack = foldTermText(text);
  const matches: TermMatch[] = [];
  for (const entry of entries) {
    const direct = matchesWholeWord(haystack, normalizeTermKey(entry.term));
    if (direct !== null) {
      matches.push({ id: entry.id, term: entry.term, matchedWord: direct, viaAlias: false });
      continue;
    }
    for (const alias of entry.aliases ?? []) {
      const hit = matchesWholeWord(haystack, normalizeTermKey(alias));
      if (hit === null) continue;
      matches.push({ id: entry.id, term: entry.term, matchedWord: hit, viaAlias: true });
      break;
    }
  }
  return matches.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

// --- digest (G-C) ---

/** The most term names `/story` Step 2 will ever load. */
export const TERM_DIGEST_CAP = 40;

export interface TermDigest {
  /**
   * Names only, sorted by term, RAW. Never entries: Step 2 loads names, not
   * definitions. Raw because the JSON payload is structured data a consumer
   * acts on, and the render sites sanitize (R7/R10): sanitizing here would put
   * the escaped form into JSON, where it is wrong, to save one call where it
   * is right.
   */
  readonly names: readonly string[];
  readonly total: number;
  readonly core: number;
  readonly returned: number;
  readonly omittedCore: number;
  readonly omittedNonCore: number;
  /** T-526 (3.7): entries with a pending note. They are listed FIRST in `names`, core or not. */
  readonly pending: number;
  /** Pending names that did not fit the cap. */
  readonly omittedPending: number;
}

/**
 * The bounded load (G-C), computed once here so the CLI and the MCP tool
 * cannot bound it differently.
 *
 * Three cases, and the middle one is the rule the cap exists for:
 *  - total at or under the cap: every name.
 *  - over the cap: only the entries marked `core`, however many that is under
 *    the cap. A session that cannot have the whole glossary should get the
 *    part someone decided it cannot work without, not the alphabetical first
 *    forty.
 *  - core itself over the cap: the first `cap` core names. The counts then say
 *    how many core names were left out, which is the signal that the `core`
 *    flag has stopped meaning anything and wants pruning.
 */
export function termDigest(entries: readonly Term[], cap: number = TERM_DIGEST_CAP): TermDigest {
  const byName = [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  const total = byName.length;
  const coreEntries = byName.filter((e) => e.core === true);
  const core = coreEntries.length;

  /**
   * T-526 (3.7): pending entries come FIRST and take their places before the
   * core rule runs, so an entry somebody deferred work on surfaces even when
   * it is not core and the glossary is over the cap. They are still bounded
   * by the cap: a pile of deferred terms is the signal, not a reason to load
   * the whole glossary.
   */
  const pendingEntries = byName.filter((e) => hasPendingNote(e));
  const pendingSelected = pendingEntries.slice(0, cap);
  const pendingIds = new Set(pendingSelected.map((e) => e.id));
  const rest = total <= cap ? byName : coreEntries;
  const selected = [...pendingSelected, ...rest.filter((e) => !pendingIds.has(e.id))].slice(0, cap);
  const returnedIds = new Set(selected.map((e) => e.id));
  const omittedCore = coreEntries.filter((e) => !returnedIds.has(e.id)).length;
  const omittedNonCore = total - selected.length - omittedCore;

  return {
    names: selected.map((e) => e.term),
    total,
    core,
    returned: selected.length,
    omittedCore,
    omittedNonCore,
    pending: pendingEntries.length,
    omittedPending: pendingEntries.length - pendingSelected.length,
  };
}
