import type { Ruling } from "../models/ruling.js";
import { escapeMarkdownDocument, escapeMarkdownInline, fencedBlock } from "./output-formatter.js";
import { classifyLifecycle, isEffectivelyAccepted, payloadDigest, proposalsAgainst, type RulingLifecycle } from "./ruling-lifecycle.js";
import { rulingAttributionCaveat, type CitationResolutionContext } from "./ruling.js";

/**
 * T-522 plan section 6: the Decisions listing, `ruling list` in Markdown and
 * the rulings section of an export.
 *
 * Sections in lifecycle order: Accepted (current and superseded), Proposed
 * (not binding), Withdrawn, Quarantined / Conflicted (with the reasons). Every
 * record's text goes through `fencedBlock` and nothing else: the text is
 * verbatim by contract and no formatter may touch it. Narrative is rendered
 * under the recorder's name, because it is the recorder's commentary and not
 * the decision. Every other free-form field (scope tags, recorder identity,
 * narrative, classification detail) goes through `escapeMarkdownDocument`:
 * this is a Markdown DOCUMENT a renderer will interpret, and those fields must
 * stay literal text, never a link, HTML or a fence. Ids are canonical and
 * take the inline escape. Every record carries the attribution caveat
 * (T-476): attribution is a claim the recorder made, not a verified fact.
 */
export interface DecisionsListingItem {
  readonly id: string;
  readonly citesRulings?: readonly string[];
}

const ORDER: readonly RulingLifecycle[] = ["accepted", "accepted-legacy", "superseded", "proposed", "withdrawn", "quarantined", "conflicted"];

/** T-528: the lifecycle order and section titles, exported so the Mac app's labels come from here, never retyped. */
export const DECISIONS_LIFECYCLE_ORDER: readonly RulingLifecycle[] = ORDER;
export function decisionsSectionTitle(lifecycle: RulingLifecycle): string {
  return section(lifecycle);
}

function section(lifecycle: RulingLifecycle): string {
  switch (lifecycle) {
    case "accepted":
    case "accepted-legacy":
    case "superseded":
      return "Accepted";
    case "proposed":
      return "Proposed (not binding)";
    case "withdrawn":
      return "Withdrawn";
    case "quarantined":
    case "conflicted":
      return "Quarantined / Conflicted";
  }
}

export function formatDecisionsListing(
  rulings: readonly Ruling[],
  lifecycleById: ReadonlyMap<string, RulingLifecycle>,
  ctx: Pick<CitationResolutionContext, "index">,
  items: readonly DecisionsListingItem[] = [],
): string {
  if (rulings.length === 0) return "No rulings found.";
  const citedBy = new Map<string, string[]>();
  for (const item of items) {
    for (const id of item.citesRulings ?? []) {
      const list = citedBy.get(id);
      if (list) list.push(item.id);
      else citedBy.set(id, [item.id]);
    }
  }
  const byLifecycle = new Map<RulingLifecycle, Ruling[]>();
  for (const r of rulings) {
    const lc = lifecycleById.get(r.id) ?? classifyLifecycle(r).lifecycle;
    const list = byLifecycle.get(lc);
    if (list) list.push(r);
    else byLifecycle.set(lc, [r]);
  }
  const out: string[] = ["# Decisions"];
  let lastSection = "";
  for (const lc of ORDER) {
    const list = byLifecycle.get(lc);
    if (!list || list.length === 0) continue;
    const title = section(lc);
    if (title !== lastSection) {
      out.push("", `## ${title}`);
      lastSection = title;
    }
    for (const r of list) out.push("", renderDecision(r, lc, rulings, ctx, citedBy.get(r.id) ?? []));
  }
  return out.join("\n");
}

function renderDecision(
  r: Ruling,
  lifecycle: RulingLifecycle,
  all: readonly Ruling[],
  ctx: Pick<CitationResolutionContext, "index">,
  citingItems: readonly string[],
): string {
  const e = escapeMarkdownInline;
  const d = escapeMarkdownDocument;
  const lines: string[] = [`### ${e(r.id)} [${lifecycle}]`, ""];
  const meta = [`Date: ${d(r.date)}`, `Attribution: ${r.attribution}`, `Recorded by: ${d(r.recordedBy.client)}/${d(r.recordedBy.id)}`];
  if (r.scopeTags.length > 0) meta.push(`Scope: ${r.scopeTags.map(d).join(", ")}`);
  lines.push(meta.join(" | "));
  lines.push(`> ${d(rulingAttributionCaveat(r.recordedBy))}`);
  if (lifecycle === "proposed" || lifecycle === "withdrawn") {
    lines.push(`Revision: ${payloadDigest(r)}`);
  }
  lines.push("", fencedBlock(r.text));
  const narrative = r.narrative;
  if (narrative && Object.values(narrative).some((v) => typeof v === "string" && v.length > 0)) {
    lines.push("", `Recorded by ${d(r.recordedBy.client)}/${d(r.recordedBy.id)} (commentary, not the decision):`);
    for (const key of ["context", "alternatives", "consequences", "reconsiderWhen"] as const) {
      const v = narrative[key];
      if (typeof v === "string" && v.length > 0) lines.push(`- ${key}: ${d(v)}`);
    }
  }
  const chain: string[] = [];
  if (r.supersedes) {
    // A stored `supersedes` is authoritative only when the index verified
    // the edge; a quarantined, conflicted or invalid record's edge is a claim.
    const verified = (ctx.index.successorsByTarget.get(r.supersedes) ?? []).includes(r.id);
    chain.push(verified ? `supersedes ${e(r.supersedes)}` : `claims to supersede ${e(r.supersedes)} (unverified)`);
  }
  if (lifecycle === "proposed" && r.proposesToSupersede) chain.push(`proposes to supersede ${e(r.proposesToSupersede)}`);
  const successors = ctx.index.successorsByTarget.get(r.id) ?? [];
  if (successors.length > 0) chain.push(`superseded by ${successors.map(e).join(", ")}`);
  const uncertain = ctx.index.uncertainSuccessorsByTarget.get(r.id) ?? [];
  if (uncertain.length > 0) chain.push(`unverifiable successor claim(s): ${uncertain.map(e).join(", ")}`);
  if (chain.length > 0) lines.push("", `Chain: ${chain.join("; ")}`);
  if (isEffectivelyAccepted(lifecycle)) {
    const proposals = proposalsAgainst(all, r.id);
    if (proposals.length > 0) lines.push(`Proposals against this ruling (not binding): ${proposals.map((p) => e(p.id)).join(", ")}`);
  }
  if (lifecycle === "proposed" && (r.proposedFor ?? []).length > 0) {
    // `proposedFor` is schema-typed as free strings, not canonical ids.
    lines.push(`Proposed for: ${(r.proposedFor ?? []).map(d).join(", ")}`);
  }
  if (citingItems.length > 0) lines.push(`Cited by: ${citingItems.map(e).join(", ")}`);
  const reasons = classifyLifecycle(r).reasons;
  if (reasons.length > 0) {
    lines.push("", "Violations:");
    for (const reason of reasons) lines.push(`- ${reason.code}: ${d(reason.detail)}`);
  }
  if (lifecycle === "conflicted") lines.push("", "Unresolved merge conflict: this record binds nothing until `storybloq resolve` settles it.");
  return lines.join("\n");
}
