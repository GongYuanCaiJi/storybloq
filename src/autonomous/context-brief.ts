/**
 * T-526: the context brief a PLAN stage reads before it plans.
 *
 * Today PLAN receives the item, the rulings it CITES and the lesson digest.
 * Nothing discovers a relevant ruling that nobody cited, names the
 * implementation that already covers the area, or delivers the capability and
 * glossary entries. This module is that discovery, and nothing else: it reads
 * the ledger and git, and it never writes (publication is
 * `context-manifest.ts`).
 *
 * Two tiers that are never merged (B-A). BINDING is what the item cites,
 * rendered by the one citation renderer and never trimmed. Everything this
 * module FINDS is SUGGESTED: evidence of possible relevance that binds nothing
 * until someone records it on the item through the existing citation
 * mechanism. A proposal is neither: it renders under its own heading (P-2).
 *
 * Every candidate carries the key that found it (P-4), and the disclosure says
 * which keys were used, so "no match" always reads as a statement about these
 * keys and never as "no existing implementation".
 */
import { createHash } from "node:crypto";
import { checkCapabilities, matchCapabilities, queryPathRefusal, type CapabilityCheckReport } from "../core/capability.js";
import { CatalogLoadError, titleWords, TITLE_STOP_WORDS } from "../core/catalog.js";
import { catalogConflictScope } from "../core/catalog-conflicts.js";
import { glossaryCatalog, matchTerms } from "../core/glossary.js";
import { loadProject } from "../core/project-loader.js";
import type { ProjectState } from "../core/project-state.js";
import { loadRulingsSafe, loadUpwardBoard } from "../core/ruling-loader.js";
import {
  buildCitationResolutionContext,
  citationWarningText,
  resolveCitation,
  resolveEntityCitations,
  type CitationResolution,
  type CitationResolutionContext,
} from "../core/ruling.js";
import { isEffectivelyAccepted, payloadDigest, proposalsFor, type RulingLifecycle } from "../core/ruling-lifecycle.js";
import { buildLessonDigest } from "../core/lessons.js";
import {
  escapeMarkdownInline,
  formatCitedRulingsSectionBounded,
  formatProposalsSectionBounded,
  PROPOSALS_TEXT_BUDGET_FRACTION,
} from "../core/output-formatter.js";
import { capabilityCatalog, catalogPath, catalogText } from "../cli/commands/capability.js";
import { hasPendingNote, type Capability } from "../models/capability.js";
import type { Term } from "../models/glossary.js";
import type { Ruling } from "../models/ruling.js";
import { CITED_RULINGS_TEXT_BUDGET_FRACTION } from "./review-context-packet.js";

// --- constants ---

/** The plan-review packet's budget (`plan-review.ts`), so the brief and the packet fit the same bound. */
export const BRIEF_BUDGET_BYTES = 16_000;
export const SUGGESTED_CAP = 8;
export const CAPABILITIES_CAP = 6;
export const STALE_CAP = 6;
export const TERMS_CAP = 10;
/** Lessons the brief lists; the full digest stays in `context-digest.md`. */
export const LESSONS_CAP = 10;
/** P-4: a title word shorter than this is too common to be a confident match on its own. */
export const CONFIDENT_WORD_LENGTH = 6;
export const NO_CONFIDENT_MATCH = "no confident match; inspect further";
export const NO_PATHS_NAMED = "no paths named; discovery used title words and phase";
/** B-A in one sentence; the PLAN instruction quotes it. */
export const TIER_RULE =
  "Suggested entries are evidence of possible relevance and bind nothing: only a ruling recorded on the item " +
  "(`ticket update --cites-ruling`) binds, and a proposal binds nothing until it is accepted.";

/** Path segments that name no area of their own, dropped from tag matching (ruling (a), 2026-09-22). */
const GENERIC_SEGMENTS: ReadonlySet<string> = new Set(["src", "lib", "test", "tests"]);

/**
 * B-B path keys. A key is a slash path (`src/jobs/`, `a/b/c.ts`) or a bare
 * file with a known extension; a segment may carry one leading dot
 * (`.github/`, `.story/`), never two, so `../` is not a key. The lookbehind refuses a start inside a word,
 * a path, a scheme or a version, which is what keeps `https://x/y.ts` and
 * `1.15.9` out; the post-filters below are the second line for the same forms.
 */
const PATH_KEY_REGEX = /(?<![\w/:.-])((?:\.?[\w-]+\/)+[\w.-]*|\.?[\w-]+\.(?:ts|tsx|js|swift|md|json|py))(?![\w/])/g;
const VERSION_REGEX = /^\d+(\.\d+)+$/;

/**
 * The context of the board a resolution came from (T-520): a citation resolved
 * one hop up carries `board: "orchestrator"`, and its record, digest and
 * lifecycle live on that board, never on this one.
 */
export function boardContext(ctx: CitationResolutionContext, board: "orchestrator" | undefined): CitationResolutionContext {
  return board === "orchestrator" && ctx.upward?.kind === "board" ? ctx.upward.ctx : ctx;
}

// --- types ---

export interface BriefItem {
  readonly id: string;
  readonly displayId: string;
  readonly kind: "ticket" | "issue";
  readonly title: string;
  readonly description: string;
  readonly phaseId: string | null;
  readonly citesRulings: readonly string[];
}

export interface BriefKeys {
  readonly phaseId: string | null;
  readonly paths: readonly string[];
  /** Path-shaped strings that the entry-point rules refuse, with why. Never matched. */
  readonly refusedPaths: readonly { readonly key: string; readonly reason: string }[];
  readonly capabilityIds: readonly string[];
  readonly titleWords: readonly string[];
}

export type FamilyState =
  | { readonly state: "ok" }
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly errorClass: string }
  | { readonly state: "check-incomplete"; readonly count: number };

export interface BriefFamilies {
  readonly rulings: FamilyState;
  readonly capabilities: FamilyState;
  readonly glossary: FamilyState;
}

export interface SuggestedRuling {
  readonly id: string;
  readonly date: string;
  readonly scopeTags: readonly string[];
  readonly text: string;
  readonly lifecycle: RulingLifecycle;
  readonly payloadDigest: string;
  readonly reasons: readonly string[];
  /** P-4: set when only short title words suggested it. */
  readonly confidence: "match" | typeof NO_CONFIDENT_MATCH;
}

export interface BriefCapability {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly entryPoints: readonly string[];
  readonly contract: string;
  readonly effectiveStatus: "current" | "review";
  readonly checkedAtSha: string;
  readonly pendingNote: string | null;
  readonly semanticDigest: string;
  readonly reasons: readonly string[];
  readonly confidence: "match" | typeof NO_CONFIDENT_MATCH;
  /** Why the effective status is `review`, from the check; empty when current. */
  readonly findings: readonly string[];
}

export interface BriefStale {
  readonly id: string;
  readonly name: string;
  readonly reasons: readonly string[];
  readonly failures: readonly string[];
  readonly pendingNote: string | null;
}

export interface BriefTerm {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  readonly distinction: string | null;
  readonly pendingNote: string | null;
  readonly semanticDigest: string;
  readonly reasons: readonly string[];
}

export type BriefTier = "binding" | "suggested" | "proposed";

export interface BriefManifestRuling {
  readonly id: string;
  readonly tier: BriefTier;
  readonly payloadDigest: string | null;
  readonly lifecycle: RulingLifecycle | null;
  readonly delivered: boolean;
}

/** Everything the manifest records that the brief itself knows; publication adds the rest. */
export interface BriefManifestDraft {
  readonly item: string;
  readonly briefHash: string;
  readonly families: BriefFamilies;
  readonly rulingsUnverifiable: readonly string[];
  readonly rulings: readonly BriefManifestRuling[];
  readonly capabilities: readonly {
    readonly id: string;
    readonly checkedAtSha: string;
    readonly effectiveStatus: "current" | "review";
    readonly semanticDigest: string;
    readonly pendingNote: string | null;
    readonly delivered: boolean;
  }[];
  readonly stale: readonly { readonly id: string; readonly reasons: readonly string[] }[];
  readonly terms: readonly {
    readonly id: string;
    readonly semanticDigest: string;
    readonly pendingNote: string | null;
    readonly delivered: boolean;
  }[];
}

export interface ContextBrief {
  readonly item: BriefItem;
  readonly keys: BriefKeys;
  readonly binding: readonly CitationResolution[];
  readonly suggested: readonly SuggestedRuling[];
  readonly proposed: readonly Ruling[];
  readonly capabilities: readonly BriefCapability[];
  readonly stale: readonly BriefStale[];
  readonly terms: readonly BriefTerm[];
  readonly lessons: readonly string[];
  readonly disclosure: readonly string[];
  readonly families: BriefFamilies;
  readonly rulingsUnverifiable: readonly string[];
  /** Ids actually present in `rendered`, per section, after fitting. */
  readonly delivered: {
    readonly suggested: readonly string[];
    readonly proposed: readonly string[];
    readonly capabilities: readonly string[];
    readonly stale: readonly string[];
    readonly terms: readonly string[];
    readonly lessons: number;
  };
  readonly rendered: string;
  readonly briefHash: string;
  readonly manifest: BriefManifestDraft;
}

export interface BuildBriefOptions {
  readonly budgetBytes?: number;
  /** A caller that already loaded the project passes it, so the ledger is not read twice. */
  readonly state?: ProjectState;
  /** Test seam for the capability check. */
  readonly checkOptions?: Parameters<typeof checkCapabilities>[3];
}

export class BriefItemNotFoundError extends Error {
  constructor(ref: string) {
    super(`${ref} could not be resolved to a ticket or issue`);
    this.name = "BriefItemNotFoundError";
  }
}

// --- digests (shared with context-manifest.ts and T-527) ---

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function capabilitySemanticDigest(cap: Capability): string {
  return sha256(
    JSON.stringify([
      cap.name,
      cap.summary,
      cap.entryPoints,
      cap.contract,
      cap.surfaces ?? {},
      sortedUnique(cap.rulings),
      sortedUnique(cap.items),
      sortedUnique(cap.terms),
    ]),
  );
}

export function termSemanticDigest(term: Term): string {
  return sha256(
    JSON.stringify([
      term.term,
      sortedUnique(term.aliases),
      term.definition,
      term.distinction ?? null,
      sortedUnique(term.capabilities),
      sortedUnique(term.rulings),
      term.core ?? false,
    ]),
  );
}

export function briefHashOf(rendered: string): string {
  return sha256(rendered);
}

// --- keys ---

/** B-B path keys from free text, in first-seen order, deduplicated. */
export function extractPathKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_KEY_REGEX)) {
    let key = m[1]!;
    const at = m.index ?? 0;
    if (at >= 3 && text.slice(at - 3, at) === "://") continue;
    while (key.endsWith(".")) key = key.slice(0, -1);
    if (key === "" || key.includes(":")) continue;
    if (VERSION_REGEX.test(key.replace(/\/$/, ""))) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Ruling (a) (ii): the segments of a path key that may match a scope tag. */
export function pathKeySegments(key: string): string[] {
  return key
    .split("/")
    .map((s) => s.toLowerCase().replace(/^\./, ""))
    .filter((s) => s.length >= 3 && !GENERIC_SEGMENTS.has(s));
}

// --- item ---

function itemFor(state: ProjectState, ref: string): BriefItem {
  const ticket = state.resolveTicketRef(ref);
  if (ticket.kind === "found") {
    const t = ticket.item;
    return {
      id: t.id,
      displayId: (t as { displayId?: string | null }).displayId ?? t.id,
      kind: "ticket",
      title: t.title,
      description: t.description ?? "",
      phaseId: t.phase ?? null,
      citesRulings: t.citesRulings ?? [],
    };
  }
  const issue = state.resolveIssueRef(ref);
  if (issue.kind === "found") {
    const i = issue.item;
    return {
      id: i.id,
      displayId: (i as { displayId?: string | null }).displayId ?? i.id,
      kind: "issue",
      title: i.title,
      // An issue's impact is its description, and its location lines are the paths it names.
      description: [i.impact, ...(i.location ?? [])].join("\n"),
      phaseId: (i as { phase?: string | null }).phase ?? null,
      citesRulings: i.citesRulings ?? [],
    };
  }
  throw new BriefItemNotFoundError(ref);
}

// --- rulings ---

interface Candidate {
  readonly ruling: Ruling;
  readonly reasons: string[];
  /** Title words that suggested it; P-4 reads these when they are the only source. */
  readonly titleWordHits: string[];
  onlyTitleWords: boolean;
}

function tagReasons(
  ruling: Ruling,
  keys: { phaseId: string | null; paths: readonly string[]; capabilityIds: readonly string[]; titleWords: readonly string[] },
): { reasons: string[]; titleWordHits: string[]; nonTitle: boolean } {
  const reasons: string[] = [];
  const titleWordHits: string[] = [];
  let nonTitle = false;
  const phase = keys.phaseId?.toLowerCase() ?? null;
  for (const raw of ruling.scopeTags ?? []) {
    const tag = raw.toLowerCase();
    if (phase !== null && tag === phase) {
      reasons.push(`tag:${raw} (phase)`);
      nonTitle = true;
    }
    for (const key of keys.paths) {
      const whole = key.toLowerCase().replace(/\/$/, "");
      if (tag === whole || pathKeySegments(key).includes(tag)) {
        reasons.push(`tag:${raw} (path ${key})`);
        nonTitle = true;
      }
    }
    for (const cap of keys.capabilityIds) {
      if (tag === cap.toLowerCase()) {
        reasons.push(`tag:${raw} (capability id)`);
        nonTitle = true;
      }
    }
    if (keys.titleWords.includes(tag) && !TITLE_STOP_WORDS.has(tag)) {
      reasons.push(`tag:${raw} (title word)`);
      titleWordHits.push(tag);
    }
  }
  return { reasons: [...new Set(reasons)], titleWordHits, nonTitle };
}

function newestFirst(a: Ruling, b: Ruling): number {
  const byDate = b.date.localeCompare(a.date);
  if (byDate !== 0) return byDate;
  const byCreated = (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

function firstLine(text: string, max = 240): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const chars = Array.from(line.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}...`;
}

// --- capabilities ---

/** Check codes that make an entry unusable as a match: the rename and deletion signal. */
export const STALE_CODES: ReadonlySet<string> = new Set(["capability_missing_path", "capability_path_escape", "capability_symlinked_path", "capability_changed"]);

function capabilityConfidence(cap: Capability, reasons: readonly string[], words: readonly string[]): "match" | typeof NO_CONFIDENT_MATCH {
  if (reasons.some((r) => !r.startsWith("title:"))) return "match";
  const own = new Set(titleWords(`${cap.name} ${cap.summary}`));
  const hits = words.filter((w) => own.has(w));
  return hits.length > 0 && hits.every((w) => w.length < CONFIDENT_WORD_LENGTH) ? NO_CONFIDENT_MATCH : "match";
}

function capabilityReasons(
  cap: Capability,
  paths: readonly string[],
  words: readonly string[],
  phaseId: string | null,
  state: ProjectState,
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (matchCapabilities([cap], { paths: [p] }).matches.length > 0) out.push(`path:${p}`);
  }
  const own = new Set(titleWords(`${cap.name} ${cap.summary}`));
  const hits = words.filter((w) => own.has(w));
  if (hits.length > 0) out.push(`title:${hits.join(",")}`);
  if (phaseId !== null && matchCapabilities([cap], { phaseId }, state).matches.length > 0) out.push(`phase:${phaseId}`);
  return out;
}

function errorClass(err: unknown): string {
  if (err instanceof CatalogLoadError) {
    const m = /: (.*)$/.exec(err.message);
    const tail = (m?.[1] ?? "").toLowerCase();
    if (tail.includes("json")) return "not valid JSON";
    if (tail.includes("symlink")) return "symlink";
    if (tail.includes("too large") || tail.includes("bytes")) return "too large";
    return "schema mismatch";
  }
  return err instanceof Error ? err.name : "read error";
}

// --- render ---

type SectionId = "suggested" | "proposed" | "capabilities" | "stale" | "terms" | "lessons";
/** 1d: the order entries are dropped in, first to last. */
const DROP_ORDER: readonly SectionId[] = ["lessons", "terms", "stale", "capabilities", "proposed", "suggested"];

function reasonsText(reasons: readonly string[]): string {
  return reasons.map((r) => catalogText(r)).join("; ");
}

function renderSuggested(r: SuggestedRuling): string {
  const tags = r.scopeTags.length > 0 ? `; tags: ${r.scopeTags.map((t) => catalogText(t)).join(", ")}` : "";
  const lines = [
    `- **${catalogText(r.id)}** (${catalogText(r.date)}${tags}): "${catalogText(firstLine(r.text))}"`,
    `  suggested by ${reasonsText(r.reasons)}`,
  ];
  if (r.confidence === NO_CONFIDENT_MATCH) lines.push(`  ${NO_CONFIDENT_MATCH}`);
  return lines.join("\n");
}

function renderCapability(c: BriefCapability): string {
  const lines = [
    `- **${catalogText(c.name)}** (${catalogText(c.id)}) [${c.effectiveStatus}]: ${catalogText(c.summary)}`,
    `  entry points: ${c.entryPoints.map((p) => catalogPath(p)).join(", ")}`,
    `  contract: ${catalogText(c.contract)}`,
    `  matched by ${reasonsText(c.reasons)}`,
  ];
  for (const f of c.findings) lines.push(`  check: ${escapeMarkdownInline(f)}`);
  if (c.pendingNote !== null) lines.push(`  review: ${catalogText(c.pendingNote)}`);
  if (c.confidence === NO_CONFIDENT_MATCH) lines.push(`  ${NO_CONFIDENT_MATCH}`);
  return lines.join("\n");
}

function renderStale(s: BriefStale): string {
  const lines = [
    `- ${catalogText(s.name)} (${catalogText(s.id)}): not usable as an implementation candidate`,
    `  matched by ${reasonsText(s.reasons)}`,
  ];
  for (const f of s.failures) lines.push(`  check: ${escapeMarkdownInline(f)}`);
  if (s.pendingNote !== null) lines.push(`  review: ${catalogText(s.pendingNote)}`);
  return lines.join("\n");
}

function renderTerm(t: BriefTerm): string {
  const lines = [`- **${catalogText(t.term)}** (${catalogText(t.id)}): ${catalogText(t.definition)}`];
  if (t.distinction !== null) lines.push(`  distinction: ${catalogText(t.distinction)}`);
  lines.push(`  matched by ${reasonsText(t.reasons)}`);
  if (t.pendingNote !== null) lines.push(`  review: ${catalogText(t.pendingNote)}`);
  return lines.join("\n");
}

interface RenderInput {
  readonly item: BriefItem;
  readonly bindingText: string;
  readonly suggested: readonly SuggestedRuling[];
  readonly proposed: readonly Ruling[];
  readonly capabilities: readonly BriefCapability[];
  readonly stale: readonly BriefStale[];
  readonly terms: readonly BriefTerm[];
  readonly lessons: readonly string[];
  readonly disclosure: readonly string[];
  readonly budget: number;
}

function renderBrief(input: RenderInput): { text: string; proposedDelivered: readonly string[] } {
  const parts: string[] = [];
  parts.push(
    `# Context brief: ${catalogText(input.item.displayId)}`,
    "",
    "## Item",
    "",
    `${catalogText(input.item.title)}${input.item.phaseId !== null ? ` (phase ${catalogText(input.item.phaseId)})` : ""}`,
  );
  parts.push(input.bindingText);
  if (input.suggested.length > 0) {
    parts.push("", "## Suggested accepted rulings", "", TIER_RULE, "", input.suggested.map(renderSuggested).join("\n"));
  }
  const proposals = formatProposalsSectionBounded(input.proposed, Math.floor(input.budget * PROPOSALS_TEXT_BUDGET_FRACTION));
  if (proposals.text !== "") parts.push(proposals.text.replace(/^\n+/, "\n"));
  if (input.capabilities.length > 0) {
    parts.push(
      "",
      "## Capabilities",
      "",
      "Where inspection starts, not a substitute for reading the implementation.",
      "",
      input.capabilities.map(renderCapability).join("\n"),
    );
  }
  if (input.stale.length > 0) parts.push("", "## Stale or unavailable", "", input.stale.map(renderStale).join("\n"));
  if (input.terms.length > 0) parts.push("", "## Terms", "", input.terms.map(renderTerm).join("\n"));
  if (input.lessons.length > 0) parts.push("", "## Lessons", "", input.lessons.join("\n"));
  parts.push("", "## Disclosure", "", input.disclosure.map((d) => `- ${d}`).join("\n"));
  const proposedDelivered = input.proposed.map((p) => p.id).filter((id) => !proposals.omittedIds.includes(id));
  return { text: `${parts.join("\n")}\n`, proposedDelivered };
}

// --- build ---

/**
 * Builds the brief for one ticket or issue. Reads the ledger once
 * (`loadRulingsSafe` feeds both tiers), runs the capability check once, and
 * reads git through that check; it writes nothing.
 */
export async function buildContextBrief(root: string, itemRef: string, opts: BuildBriefOptions = {}): Promise<ContextBrief> {
  const budget = opts.budgetBytes ?? BRIEF_BUDGET_BYTES;
  const state = opts.state ?? (await loadProject(root)).state;
  const item = itemFor(state, itemRef);
  const disclosure: string[] = [];

  // Keys.
  const text = `${item.title}\n${item.description}`;
  const rawPaths = extractPathKeys(text);
  const paths: string[] = [];
  const refusedPaths: { key: string; reason: string }[] = [];
  for (const p of rawPaths) {
    const refusal = queryPathRefusal(p);
    if (refusal === null) paths.push(p);
    else refusedPaths.push({ key: p, reason: refusal });
  }
  const words = titleWords(item.title);

  // Rulings: one scan for binding, suggested and proposed.
  const scan = loadRulingsSafe(root);
  const local = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries);
  let ctx: CitationResolutionContext = local;
  if (item.citesRulings.length > 0) {
    const upward = loadUpwardBoard(root);
    if (upward) ctx = { ...local, upward };
  }
  const binding = resolveEntityCitations(item, ctx);
  const rulingsFamily: FamilyState =
    scan.scanCompleteness === "complete" ? { state: "ok" } : { state: "unreadable", errorClass: "rulings scan incomplete" };
  const rulingsUnverifiable: string[] = [];
  const bindingIds = new Set<string>();
  for (const b of binding) {
    bindingIds.add(b.citedId);
    if (b.status === "resolved") bindingIds.add(b.current.id);
    else rulingsUnverifiable.push(b.citedId);
  }
  const lifecycle = (id: string): RulingLifecycle | null => ctx.lifecycleById.get(id) ?? null;

  // Capabilities: one check, then the stale set out of the match.
  let capabilitiesFamily: FamilyState = { state: "ok" };
  let entries: readonly Capability[] = [];
  let conflictRecords: unknown;
  try {
    const loaded = capabilityCatalog.load(root);
    if (!loaded.present) capabilitiesFamily = { state: "missing" };
    entries = loaded.doc.capabilities;
    conflictRecords = loaded.doc._conflicts;
  } catch (err) {
    capabilitiesFamily = { state: "unreadable", errorClass: errorClass(err) };
  }
  // T-529: an entry the file's own conflict records name reads `review` and is
  // never suggested; it is listed as excluded instead.
  const conflictScope = catalogConflictScope({ _conflicts: conflictRecords }, entries.map((e) => e.id));
  let report: CapabilityCheckReport | null = null;
  if (entries.length > 0) {
    report = await checkCapabilities(root, entries, state, {
      ...(opts.checkOptions ?? {}),
      conflictedIds: conflictScope.conflictedIds,
      problemIds: conflictScope.problemIds,
    });
    if (report.deadlineHit || report.unchecked.length > 0) {
      capabilitiesFamily = { state: "check-incomplete", count: new Set(report.unchecked).size };
    }
  }
  const checkOf = (id: string) => report?.entries.find((e) => e.id === id);
  const staleIds = new Map<string, string>();
  for (const e of report?.entries ?? []) {
    const hit = e.results.find((r) => STALE_CODES.has(r.code));
    if (hit) staleIds.set(e.id, hit.detail);
  }
  const criteria = { paths, title: item.title, ...(item.phaseId !== null && { phaseId: item.phaseId }) };
  const matched = entries.length > 0 ? matchCapabilities(entries, criteria, state, new Map([...staleIds, ...conflictScope.excluded])).matches : [];
  const matchedCaps = matched.map((m) => m.capability);
  const capabilities: BriefCapability[] = matchedCaps.map((cap) => {
    const reasons = capabilityReasons(cap, paths, words, item.phaseId, state);
    const checked = checkOf(cap.id);
    return {
      id: cap.id,
      name: cap.name,
      summary: cap.summary,
      entryPoints: cap.entryPoints,
      contract: cap.contract,
      effectiveStatus: checked?.effectiveStatus ?? (hasPendingNote(cap) ? "review" : cap.status),
      checkedAtSha: cap.checkedAt.sha,
      pendingNote: hasPendingNote(cap) ? cap.pendingNote! : null,
      semanticDigest: capabilitySemanticDigest(cap),
      reasons,
      confidence: capabilityConfidence(cap, reasons, words),
      findings: (checked?.results ?? []).map((r) => r.detail),
    };
  });
  // Path matches first, then the rest in inventory order: a path is the strongest key.
  capabilities.sort((a, b) => Number(!a.reasons.some((r) => r.startsWith("path:"))) - Number(!b.reasons.some((r) => r.startsWith("path:"))));
  const staleEntries = entries.filter((e) => staleIds.has(e.id));
  const stale: BriefStale[] = (staleEntries.length > 0 ? matchCapabilities(staleEntries, criteria, state).matches : []).map((m) => ({
    id: m.capability.id,
    name: m.capability.name,
    reasons: capabilityReasons(m.capability, paths, words, item.phaseId, state),
    failures: (checkOf(m.capability.id)?.results ?? []).filter((r) => r.cls !== "freshness" || r.code === "capability_changed").map((r) => r.detail),
    pendingNote: hasPendingNote(m.capability) ? m.capability.pendingNote! : null,
  }));
  const capabilityIds = matchedCaps.map((c) => c.id);

  // Suggested rulings: tag matches plus matched capabilities' direct rulings.
  const keys = { phaseId: item.phaseId, paths, capabilityIds, titleWords: words };
  const candidates = new Map<string, Candidate>();
  const add = (ruling: Ruling, reasons: readonly string[], titleHits: readonly string[], nonTitle: boolean): void => {
    const existing = candidates.get(ruling.id);
    if (existing) {
      for (const r of reasons) if (!existing.reasons.includes(r)) existing.reasons.push(r);
      existing.titleWordHits.push(...titleHits);
      existing.onlyTitleWords = existing.onlyTitleWords && !nonTitle;
      return;
    }
    candidates.set(ruling.id, { ruling, reasons: [...reasons], titleWordHits: [...titleHits], onlyTitleWords: !nonTitle });
  };
  const forwards: { current: Ruling; from: string; tr: ReturnType<typeof tagReasons> }[] = [];
  for (const ruling of scan.rulings) {
    const tr = tagReasons(ruling, keys);
    if (tr.reasons.length === 0) continue;
    const lc = lifecycle(ruling.id);
    if (lc === "accepted" || lc === "accepted-legacy") {
      add(ruling, tr.reasons, tr.titleWordHits, tr.nonTitle);
    } else if (lc === "superseded") {
      // A superseded ruling is never suggested itself; its current successor is.
      const res = resolveCitation(ruling.id, ctx);
      if (res.status === "resolved" && res.current.id !== ruling.id) {
        const current = scan.rulings.find((r) => r.id === res.current.id);
        if (current && isEffectivelyAccepted(lifecycle(current.id) ?? "proposed")) forwards.push({ current, from: ruling.id, tr });
      }
    }
  }
  // Applied after every direct match, so a successor found on its own key is not
  // listed a second time through its predecessor.
  for (const f of forwards) {
    if (candidates.has(f.current.id)) continue;
    add(f.current, f.tr.reasons.map((r) => `${r} via superseded ${f.from}`), f.tr.titleWordHits, f.tr.nonTitle);
  }
  for (const cap of matchedCaps) {
    for (const id of cap.rulings ?? []) {
      const res = resolveCitation(id, ctx);
      if (res.status !== "resolved") {
        if (!bindingIds.has(id) && !rulingsUnverifiable.includes(id)) rulingsUnverifiable.push(id);
        disclosure.push(`ruling ${catalogText(id)} (linked from ${catalogText(cap.id)}) could not be resolved: ${escapeMarkdownInline(citationWarningText(res))}`);
        continue;
      }
      const current = scan.rulings.find((r) => r.id === res.current.id);
      if (current) add(current, [`capability:${cap.id}`], [], true);
    }
  }
  const suggestedAll: SuggestedRuling[] = [...candidates.values()]
    .filter((c) => !bindingIds.has(c.ruling.id))
    .sort((a, b) => newestFirst(a.ruling, b.ruling))
    .map((c) => ({
      id: c.ruling.id,
      date: c.ruling.date,
      scopeTags: c.ruling.scopeTags ?? [],
      text: c.ruling.text,
      lifecycle: lifecycle(c.ruling.id) ?? "accepted-legacy",
      payloadDigest: payloadDigest(c.ruling),
      reasons: c.reasons,
      confidence:
        c.onlyTitleWords && c.titleWordHits.length > 0 && c.titleWordHits.every((w) => w.length < CONFIDENT_WORD_LENGTH)
          ? NO_CONFIDENT_MATCH
          : "match",
    }));
  const proposedAll = proposalsFor(scan.rulings, item.id);

  // Terms.
  let glossaryFamily: FamilyState = { state: "ok" };
  let termEntries: readonly Term[] = [];
  try {
    const loaded = glossaryCatalog.load(root);
    if (!loaded.present) glossaryFamily = { state: "missing" };
    termEntries = loaded.doc.terms;
  } catch (err) {
    glossaryFamily = { state: "unreadable", errorClass: errorClass(err) };
  }
  const termReasons = new Map<string, string[]>();
  for (const m of matchTerms(text, termEntries)) termReasons.set(m.id, [`text:${m.matchedWord}`]);
  for (const cap of matchedCaps) {
    for (const id of cap.terms ?? []) {
      if (!termEntries.some((t) => t.id === id)) continue;
      const list = termReasons.get(id) ?? [];
      list.push(`capability:${cap.id}`);
      termReasons.set(id, list);
    }
  }
  const termsAll: BriefTerm[] = termEntries
    .filter((t) => termReasons.has(t.id))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .map((t) => ({
      id: t.id,
      term: t.term,
      definition: t.definition,
      distinction: t.distinction ?? null,
      pendingNote: hasPendingNote(t) ? t.pendingNote! : null,
      semanticDigest: termSemanticDigest(t),
      reasons: termReasons.get(t.id)!,
    }));

  const lessonsAll = buildLessonDigest(state.lessons, { limit: LESSONS_CAP })
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => `- ${escapeMarkdownInline(sanitizeLine(l.slice(2)))}`);

  // Caps (B-C), each disclosed with its count and where to list the rest.
  const suggested = suggestedAll.slice(0, SUGGESTED_CAP);
  const capsShown = capabilities.slice(0, CAPABILITIES_CAP);
  const staleShown = stale.slice(0, STALE_CAP);
  const termsShown = termsAll.slice(0, TERMS_CAP);
  const capDisclosure: string[] = [];
  if (suggestedAll.length > SUGGESTED_CAP) {
    capDisclosure.push(`${suggestedAll.length - SUGGESTED_CAP} suggested ruling(s) not shown (cap ${SUGGESTED_CAP}, newest first); list them with \`storybloq ruling list --scope-tag <tag>\``);
  }
  if (capabilities.length > CAPABILITIES_CAP) {
    capDisclosure.push(`${capabilities.length - CAPABILITIES_CAP} capability match(es) not shown (cap ${CAPABILITIES_CAP}); list them with \`storybloq capability match\``);
  }
  if (stale.length > STALE_CAP) {
    capDisclosure.push(`${stale.length - STALE_CAP} stale capability match(es) not shown (cap ${STALE_CAP}); list them with \`storybloq capability check\``);
  }
  if (termsAll.length > TERMS_CAP) {
    capDisclosure.push(`${termsAll.length - TERMS_CAP} term match(es) not shown (cap ${TERMS_CAP}); list them with \`storybloq term match\``);
  }

  // Disclosure (keys, families, bounds).
  const keyParts: string[] = [];
  if (item.phaseId !== null) keyParts.push(`phase ${catalogText(item.phaseId)}`);
  if (paths.length > 0) keyParts.push(`paths ${paths.map((p) => catalogPath(p)).join(", ")}`);
  if (capabilityIds.length > 0) keyParts.push(`capabilities ${capabilityIds.map((c) => catalogText(c)).join(", ")}`);
  if (words.length > 0) keyParts.push(`title words ${words.join(", ")}`);
  const head: string[] = [`keys used: ${keyParts.length > 0 ? keyParts.join("; ") : "none"}`];
  if (paths.length === 0) head.push(NO_PATHS_NAMED);
  for (const r of refusedPaths) head.push(`path key ignored: ${escapeMarkdownInline(r.reason)}`);
  head.push("discovery was bounded to these keys; no match is not evidence that no implementation exists");
  if (rulingsFamily.state === "unreadable") head.push(`rulings unavailable: ${rulingsFamily.errorClass}`);
  if (scan.unavailableIds.size > 0 || scan.hasUnrecoverableEntries) {
    const n = scan.unavailableIds.size + (scan.hasUnrecoverableEntries ? 1 : 0);
    head.push(`${n} ruling file(s) could not be read; a matching ruling may be among them`);
  }
  for (const id of rulingsUnverifiable) {
    const b = binding.find((x) => x.citedId === id);
    if (b) head.push(`ruling ${catalogText(id)} could not be resolved: ${escapeMarkdownInline(citationWarningText(b))}`);
  }
  head.push(...familyLines(capabilitiesFamily, "capabilities", "no capability inventory"));
  head.push(...familyLines(glossaryFamily, "glossary", "no glossary"));
  head.push(...disclosure, ...capDisclosure);

  // Fitting (1d).
  const bindingText =
    binding.length > 0
      ? formatCitedRulingsSectionBounded(binding, Math.floor(budget * CITED_RULINGS_TEXT_BUDGET_FRACTION)).text.replace(/^\n+/, "\n")
      : "\n## Cited Rulings\n\nnone: this item cites no rulings";
  const sections: Record<SectionId, unknown[]> = {
    suggested: [...suggested],
    proposed: [...proposedAll],
    capabilities: [...capsShown],
    stale: [...staleShown],
    terms: [...termsShown],
    lessons: [...lessonsAll],
  };
  const dropped: Record<SectionId, number> = { suggested: 0, proposed: 0, capabilities: 0, stale: 0, terms: 0, lessons: 0 };
  const render = (overBy: number | null): { text: string; proposedDelivered: readonly string[] } => {
    const fitLines = DROP_ORDER.filter((s) => dropped[s] > 0).map(
      (s) => `omitted to fit the ${budget}-byte budget: ${dropped[s]} ${SECTION_LABEL[s]}`,
    );
    const over = overBy !== null ? [`brief over budget by ${overBy} bytes: mandatory sections only`] : [];
    return renderBrief({
      item,
      bindingText,
      suggested: sections.suggested as SuggestedRuling[],
      proposed: sections.proposed as Ruling[],
      capabilities: sections.capabilities as BriefCapability[],
      stale: sections.stale as BriefStale[],
      terms: sections.terms as BriefTerm[],
      lessons: sections.lessons as string[],
      disclosure: [...head, ...fitLines, ...over],
      budget,
    });
  };
  let out = render(null);
  for (;;) {
    const bytes = Buffer.byteLength(out.text, "utf8");
    if (bytes <= budget) break;
    const next = DROP_ORDER.find((s) => sections[s].length > 0);
    if (next === undefined) {
      // The over-budget line itself adds bytes, and a wider number adds more;
      // render until the stated overshoot is the overshoot of the text stating it.
      let claimed = bytes - budget;
      out = render(claimed);
      for (let actual = Buffer.byteLength(out.text, "utf8") - budget; actual !== claimed; actual = Buffer.byteLength(out.text, "utf8") - budget) {
        claimed = actual;
        out = render(claimed);
      }
      break;
    }
    sections[next].pop();
    dropped[next] += 1;
    out = render(null);
  }

  const rendered = out.text;
  const briefHash = briefHashOf(rendered);
  const deliveredSuggested = (sections.suggested as SuggestedRuling[]).map((r) => r.id);
  const deliveredCaps = (sections.capabilities as BriefCapability[]).map((c) => c.id);
  const deliveredStale = (sections.stale as BriefStale[]).map((s) => s.id);
  const deliveredTerms = (sections.terms as BriefTerm[]).map((t) => t.id);
  const families: BriefFamilies = { rulings: rulingsFamily, capabilities: capabilitiesFamily, glossary: glossaryFamily };

  const manifestRulings: BriefManifestRuling[] = [];
  for (const b of binding) {
    if (b.status !== "resolved") continue;
    const on = boardContext(ctx, b.board);
    const current = on.rulingsById.get(b.current.id);
    manifestRulings.push({
      id: b.current.id,
      tier: "binding",
      payloadDigest: current ? payloadDigest(current) : null,
      lifecycle: on.lifecycleById.get(b.current.id) ?? null,
      delivered: true,
    });
  }
  for (const r of suggestedAll) {
    manifestRulings.push({ id: r.id, tier: "suggested", payloadDigest: r.payloadDigest, lifecycle: r.lifecycle, delivered: deliveredSuggested.includes(r.id) });
  }
  for (const p of proposedAll) {
    manifestRulings.push({ id: p.id, tier: "proposed", payloadDigest: payloadDigest(p), lifecycle: lifecycle(p.id), delivered: out.proposedDelivered.includes(p.id) });
  }

  return {
    item,
    keys: { phaseId: item.phaseId, paths, refusedPaths, capabilityIds, titleWords: words },
    binding,
    suggested: suggestedAll,
    proposed: proposedAll,
    capabilities,
    stale,
    terms: termsAll,
    lessons: lessonsAll,
    disclosure: [...head],
    families,
    rulingsUnverifiable,
    delivered: {
      suggested: deliveredSuggested,
      proposed: out.proposedDelivered,
      capabilities: deliveredCaps,
      stale: deliveredStale,
      terms: deliveredTerms,
      lessons: sections.lessons.length,
    },
    rendered,
    briefHash,
    manifest: {
      item: item.id,
      briefHash,
      families,
      rulingsUnverifiable,
      rulings: manifestRulings,
      capabilities: capabilities.map((c) => ({
        id: c.id,
        checkedAtSha: c.checkedAtSha,
        effectiveStatus: c.effectiveStatus,
        semanticDigest: c.semanticDigest,
        pendingNote: c.pendingNote,
        delivered: deliveredCaps.includes(c.id),
      })),
      stale: stale.map((s) => ({ id: s.id, reasons: s.reasons })),
      terms: termsAll.map((t) => ({ id: t.id, semanticDigest: t.semanticDigest, pendingNote: t.pendingNote, delivered: deliveredTerms.includes(t.id) })),
    },
  };
}

const SECTION_LABEL: Readonly<Record<SectionId, string>> = {
  suggested: "suggested ruling(s)",
  proposed: "proposal(s)",
  capabilities: "capability match(es)",
  stale: "stale capability match(es)",
  terms: "term(s)",
  lessons: "lesson(s)",
};

function familyLines(f: FamilyState, name: string, missing: string): string[] {
  switch (f.state) {
    case "ok":
      return [];
    case "missing":
      return [missing];
    case "unreadable":
      return [`${name} unavailable: ${f.errorClass}`];
    case "check-incomplete":
      return [`${name} check-incomplete: ${f.count} entry(ies) not checked; their status is not verified`];
  }
}

function sanitizeLine(text: string): string {
  return catalogText(text, (s) => s);
}
