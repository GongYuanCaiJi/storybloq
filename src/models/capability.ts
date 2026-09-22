import { z } from "zod";
import {
  DateSchema,
  RulingIdSchema,
  TICKET_ID_REGEX,
  TICKET_CANONICAL_ID_REGEX,
  ISSUE_ID_REGEX,
  ISSUE_CANONICAL_ID_REGEX,
} from "./types.js";

/**
 * T-523: the capability inventory. One entry answers "what can this project
 * already do, where does it live, what does it guarantee, and what decision
 * put it there" -- the four things a session cannot recover from a slice of
 * the repo, and whose absence is what let a shipped lookup be declared missing
 * (the 2026-09-20 scope-tag ruling that produced this ticket).
 *
 * An entry is where inspection STARTS (C-A). It carries pointers and a
 * contract, never architecture prose: rationale stays in notes and rulings and
 * is reached from here by id.
 *
 * `.passthrough()` matches every other catalog-adjacent model (RulingSchema,
 * LessonSchema, ArrangementSchema): unknown fields survive a parse/rewrite
 * round trip, so an older CLI never silently strips a newer field back out of
 * a tracked, shared file.
 */

/**
 * Slug body shared by `cap-` and `term-` ids. The prefixed forms are DERIVED
 * from it rather than spelled out again: two spellings of one identity rule is
 * the defect class this ticket has already hit repeatedly, and a slug that
 * drifts between the two catalogs would let an id pass one and fail the other.
 */
export const CATALOG_SLUG_PATTERN = "[a-z0-9-]{1,48}";
export const CATALOG_SLUG_REGEX = new RegExp(`^${CATALOG_SLUG_PATTERN}$`);

const CAPABILITY_ID_REGEX = new RegExp(`^cap-${CATALOG_SLUG_PATTERN}$`);
const TERM_ID_REGEX = new RegExp(`^term-${CATALOG_SLUG_PATTERN}$`);

export const CapabilityIdSchema = z
  .string()
  .refine((v) => CAPABILITY_ID_REGEX.test(v), "Capability ID must match cap-<slug> ([a-z0-9-], 1-48 chars)");

export const TermIdSchema = z
  .string()
  .refine((v) => TERM_ID_REGEX.test(v), "Term ID must match term-<slug> ([a-z0-9-], 1-48 chars)");

/**
 * A T- or ISS- id in either canonical form. The ledger is permanently mixed
 * (legacy display-ID filenames and post-migration hash filenames both being
 * canonical), so an item reference accepts whichever form the referenced item
 * actually carries rather than forcing one spelling.
 */
export const CapabilityItemRefSchema = z
  .string()
  .refine(
    (v) =>
      TICKET_ID_REGEX.test(v) ||
      TICKET_CANONICAL_ID_REGEX.test(v) ||
      ISSUE_ID_REGEX.test(v) ||
      ISSUE_CANONICAL_ID_REGEX.test(v),
    "Item ref must be a ticket (T-NNN, T-NNNx, t-[canonical]) or issue (ISS-NNN, i-[canonical]) id",
  );

/**
 * The ONE entry-point normalizer, shared by the schema and by `match`'s query
 * side so the two cannot disagree about what a path component is.
 *
 * Only lossless rewrites: a `.` segment and an empty segment (a repeated or
 * trailing slash) name nothing, so dropping them cannot change which path is
 * meant. A leading `/` is KEPT, because dropping it would turn an absolute path
 * into a relative one, which is not lossless; the absolute rule then refuses
 * it. `..` is left alone for the same reason: `a/b/..` is not `a` when `b` is a
 * symlink, so it is rejected rather than resolved.
 */
export function normalizeEntryPoint(v: string): string {
  const segments = v.split("/").filter((seg) => seg !== "" && seg !== ".");
  return (v.startsWith("/") ? "/" : "") + segments.join("/");
}

/**
 * The entry-point RULES, as predicates over a NORMALIZED path. This is the one
 * rule source: `EntryPointSchema` applies it to the entry side and `match`
 * applies it to the query side, and each words its own message. A rule added
 * here reaches both, so the two sides cannot drift into accepting different
 * forms, which is how `src/core/../other` came to be refused as an entry point
 * and silently matched as a query.
 *
 * In order:
 *  - `root`: the path names the repo root. Only `.`, `./` and the like (and
 *    the empty string) normalize to empty. The root is not an entry point: it
 *    would make every change in the repository a change to this capability.
 *  - `absolute`: a leading `/` survives normalization and is refused here.
 *  - `parent`: a `..` SEGMENT. Segment-aware matters both ways -- a file
 *    legitimately named `a..b` is not traversal, and `src/../etc` is -- and the
 *    same segment boundary is what `match`'s ancestor rule uses.
 *  - `backslash`: the principle applied to an AMBIGUOUS form.
 *    `src\core\thing.ts` passes every rule above -- it splits on `/` into one
 *    segment with no `..` -- and is then useless in both directions and
 *    silently so: git's `--name-only` output uses forward slashes, so the
 *    `:(literal)` pathspec never matches and the entry can never go stale,
 *    while `match` splits query and entry point on `/` and never relates them.
 *    It is rejected rather than normalized because a backslash is a legal
 *    character in a POSIX filename: `weird\name.ts` may be exactly the file
 *    meant, so rewriting it to `weird/name.ts` could silently turn a correct
 *    path into a wrong one. The text alone cannot say which was intended.
 */
export const ENTRY_POINT_RULES = ["root", "absolute", "parent", "backslash"] as const;
export type EntryPointRule = (typeof ENTRY_POINT_RULES)[number];

const ENTRY_POINT_RULE_HOLDS: Readonly<Record<EntryPointRule, (normalized: string) => boolean>> = {
  root: (v) => v.length > 0,
  absolute: (v) => !v.startsWith("/"),
  parent: (v) => !v.split("/").includes(".."),
  backslash: (v) => !v.includes("\\"),
};

/** Every rule a normalized path breaks, in rule order; empty when it is a legal entry point. */
export function entryPointViolations(normalized: string): EntryPointRule[] {
  return ENTRY_POINT_RULES.filter((rule) => !ENTRY_POINT_RULE_HOLDS[rule](normalized));
}

const ENTRY_POINT_MESSAGES: Readonly<Record<EntryPointRule, string>> = {
  root: "Entry point names the repo root, which is not an entry point: name the file or directory the capability lives in",
  absolute: "Entry point must be repo-relative, not absolute",
  parent: "Entry point must not contain a `..` segment",
  backslash:
    "Entry point must use forward slashes: a backslash path passes every other rule here and then silently never matches anything",
};

/**
 * A repo-relative POSIX entry point.
 *
 * LOSSLESS FORMS ARE NORMALIZED, AMBIGUOUS FORMS ARE REJECTED. `./src//core/`
 * and `src/core` name the same path, so the first is rewritten to the second;
 * a form whose meaning cannot be recovered from the text alone is refused
 * rather than guessed at. The normalization runs BEFORE every rule, so each
 * rule judges the path that will be stored, compared against git's output and
 * matched against a query: git emits `src/core/x.ts`, never `./src/core/x.ts`,
 * and an entry stored in the un-normalized form would never be matched by a
 * changed file and would report `current` forever.
 *
 * The rules are `ENTRY_POINT_RULES` above, one issue per broken rule.
 */
export const EntryPointSchema = z
  .string()
  .min(1, "Entry point cannot be empty")
  .transform(normalizeEntryPoint)
  .superRefine((v, ctx) => {
    for (const rule of entryPointViolations(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: ENTRY_POINT_MESSAGES[rule] });
    }
  });

/**
 * Where a capability is reachable from. `cli` and `mcp` names are checked
 * against `storybloq reference`'s own COMMANDS/MCP_TOOLS inventory by
 * `check`, which is what stops this file from inventing an interface the
 * product does not expose.
 */
export const CapabilitySurfacesSchema = z
  .object({
    cli: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    app: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * The commit at which a human or the pen actually READ the entry points and
 * confirmed the contract. Freshness is a tree diff from here to HEAD, so this
 * is a claim about inspection, not about when the file was edited.
 */
export const CapabilityCheckpointSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{7,40}$/, "Checkpoint sha must be 7-40 lowercase hex characters"),
    date: DateSchema,
  })
  .passthrough();

/**
 * The STORED status is the manual flag only. Every reader shows the EFFECTIVE
 * status, which folds in freshness and structural results computed at read
 * time -- see `effectiveStatus` in `src/core/capability.ts`. Nothing but
 * `check --stamp` and an explicit `update --status` writes this field.
 */
export const CAPABILITY_STATUSES = ["current", "review"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CapabilitySchema = z
  .object({
    id: CapabilityIdSchema,
    name: z.string().min(1, "Capability name cannot be empty"),
    summary: z.string().min(1, "Capability summary cannot be empty"),
    surfaces: CapabilitySurfacesSchema.default({}),
    entryPoints: z.array(EntryPointSchema).min(1, "A capability needs at least one entry point: an entry with none can never go stale and can never be found by path"),
    contract: z.string().min(1, "Capability contract cannot be empty"),
    example: z.string().optional(),
    rulings: z.array(RulingIdSchema).optional(),
    items: z.array(CapabilityItemRefSchema).optional(),
    terms: z.array(TermIdSchema).optional(),
    checkedAt: CapabilityCheckpointSchema,
    status: z.enum(CAPABILITY_STATUSES).default("current"),
  })
  .passthrough()
  /**
   * An entry point may appear once. A repeat is an AMBIGUOUS form in the sense
   * of the entry-point rule: it is either a harmless repeat or a typo for a
   * different path, and the text cannot say which. Silently deduplicating would
   * resolve it in the direction that hides the typo, and a typo'd entry point
   * is an unwatched file, which is the failure this field's validation exists
   * to prevent.
   *
   * Compared AFTER normalization (the array holds `EntryPointSchema` output),
   * so `./src/core` beside `src/core` is caught. EXACT equality only:
   * `src/core` beside `src/core/x.ts` is overlap, not duplication, and stays
   * legal, since narrowing a broad entry with a specific one is reasonable.
   *
   * The message names the path, which is the author's own input at write time.
   * At load time it never reaches the caller: the catalog load diagnostic
   * reports the issue's location and code only (see `safeIssueLocation`).
   */
  .superRefine((cap, ctx) => {
    const seen = new Map<string, number>();
    cap.entryPoints.forEach((path, index) => {
      const first = seen.get(path);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entryPoints", index],
          message: `Duplicate entry point ${path} (first at entryPoints.${first}); name each path once`,
        });
      } else {
        seen.set(path, index);
      }
    });
  });

/**
 * The file document. `version` is a literal rather than a number so a future
 * version 2 file fails the parse and surfaces as a CatalogLoadError, instead
 * of passing through and being rewritten by an older CLI that does not
 * understand it.
 */
export const CapabilityCatalogSchema = z
  .object({
    version: z.literal(1),
    capabilities: z.array(CapabilitySchema).default([]),
  })
  .passthrough()
  /**
   * Ids are unique. Everything downstream keys by id -- `checkCapabilities`
   * stores results in a Map, `get` and `update` select the first match -- so a
   * duplicate did not fail loudly, it MASKED: the second entry's results
   * overwrote the first's, and a broken entry sharing an id with a valid one
   * reported `current`. A hand edit or a merge can produce one, so the load
   * refuses it rather than trusting every writer to have prevented it.
   */
  .superRefine((doc, ctx) => {
    const seen = new Map<string, number>();
    doc.capabilities.forEach((cap, index) => {
      const first = seen.get(cap.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", index, "id"],
          message: `Duplicate capability id ${cap.id} (first at capabilities.${first})`,
        });
      } else {
        seen.set(cap.id, index);
      }
    });
  });

export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilitySurfaces = z.infer<typeof CapabilitySurfacesSchema>;
export type CapabilityCheckpoint = z.infer<typeof CapabilityCheckpointSchema>;
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
