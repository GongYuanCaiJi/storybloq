import { createHash } from "node:crypto";
import { RulingSchema, type Ruling } from "../models/ruling.js";

/**
 * T-522: the proposal lifecycle, DERIVED at read time from a record's shape.
 *
 * Nothing here is stored. A record stores at most a `status` and the
 * evidence around it (`acceptance`, `withdrawal`); what the record IS to a
 * reader -- binding, pending, dead, or untrustworthy -- is classified here
 * from that evidence every time, so an edit that invalidates the evidence
 * demotes the record on the next read rather than being trusted because a
 * status field still says "accepted".
 *
 * The seven lifecycles:
 *   proposed        status proposed, no supersedes edge; binds nothing.
 *   withdrawn       status withdrawn, no supersedes edge; binds nothing.
 *   accepted        status accepted with acceptance evidence whose digest
 *                   matches the payload and whose edge matches the request.
 *   accepted-legacy no status at all: a 1.15 record, accepted by shape. No
 *                   digest is ever computed or expected for it.
 *   superseded      effectively accepted, with an authoritative successor.
 *   quarantined     claims a state its evidence does not support. Stays in
 *                   the loaded set (it is a real file a reader must see) but
 *                   binds nothing and its edges are UNCERTAIN, never
 *                   authoritative.
 *   conflicted      carries merge `_conflicts`; nothing about it is settled.
 *
 * "Effectively accepted" (accepted, accepted-legacy, superseded) is the set
 * whose `supersedes` edges the successor index trusts and whose citation
 * resolves to a ruling that binds.
 */
export type RulingLifecycle =
  | "proposed"
  | "withdrawn"
  | "accepted"
  | "accepted-legacy"
  | "superseded"
  | "quarantined"
  | "conflicted";

export type LifecycleReasonCode =
  | "ruling_proposed_with_supersedes"
  | "ruling_status_without_acceptance"
  | "ruling_acceptance_digest_mismatch"
  | "ruling_acceptance_edge_mismatch";

export interface LifecycleReason {
  readonly code: LifecycleReasonCode;
  readonly detail: string;
}

export interface LifecycleClassification {
  /** The base lifecycle: never `superseded`, which needs the successor index (`lifecycleOf`). */
  readonly lifecycle: Exclude<RulingLifecycle, "superseded">;
  readonly reasons: readonly LifecycleReason[];
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The digest an acceptance binds to: sha256 over a canonical projection of
 * the decision itself. Strings are verbatim (a trailing space is a different
 * ruling); list fields are sorted and deduplicated by code point; absent,
 * null and empty collapse together for the edge and the item list. The
 * projection is the SAME for a proposal and for its accepted form, so the
 * digest recorded at acceptance can be recomputed from the record forever
 * after. Narrative, dates and recorder identity are deliberately outside it:
 * they describe the decision, they are not the decision.
 */
export function payloadDigest(ruling: Pick<Ruling, "text" | "attribution" | "scopeTags" | "proposesToSupersede" | "proposedFor">): string {
  const projection = [
    ruling.text,
    ruling.attribution,
    sortedUnique(ruling.scopeTags),
    ruling.proposesToSupersede ?? null,
    sortedUnique(ruling.proposedFor),
  ];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function hasConflictEntries(ruling: Ruling): boolean {
  const conflicts = (ruling as Record<string, unknown>)._conflicts;
  return Array.isArray(conflicts) && conflicts.length > 0;
}

export function classifyLifecycle(ruling: Ruling): LifecycleClassification {
  if (hasConflictEntries(ruling)) return { lifecycle: "conflicted", reasons: [] };
  const status = ruling.status;
  if (status === undefined) return { lifecycle: "accepted-legacy", reasons: [] };

  const reasons: LifecycleReason[] = [];
  if (status === "proposed" || status === "withdrawn") {
    if (ruling.supersedes) {
      reasons.push({
        code: "ruling_proposed_with_supersedes",
        detail: `${ruling.id} is ${status} but carries supersedes ${ruling.supersedes}; only accept may write that edge`,
      });
      return { lifecycle: "quarantined", reasons };
    }
    return { lifecycle: status, reasons };
  }

  // status === "accepted"
  if (!ruling.acceptance) {
    reasons.push({
      code: "ruling_status_without_acceptance",
      detail: `${ruling.id} claims status accepted with no acceptance record`,
    });
    return { lifecycle: "quarantined", reasons };
  }
  const expected = payloadDigest(ruling);
  if (ruling.acceptance.payloadDigest !== expected) {
    reasons.push({
      code: "ruling_acceptance_digest_mismatch",
      detail: `${ruling.id} was edited after acceptance: payload digest ${expected} does not match the accepted ${ruling.acceptance.payloadDigest}`,
    });
  }
  if ((ruling.supersedes ?? null) !== (ruling.proposesToSupersede ?? null)) {
    reasons.push({
      code: "ruling_acceptance_edge_mismatch",
      detail: `${ruling.id} supersedes ${ruling.supersedes ?? "nothing"} but its accepted proposal named ${ruling.proposesToSupersede ?? "nothing"}`,
    });
  }
  return reasons.length > 0 ? { lifecycle: "quarantined", reasons } : { lifecycle: "accepted", reasons };
}

export function isEffectivelyAccepted(lifecycle: RulingLifecycle): boolean {
  return lifecycle === "accepted" || lifecycle === "accepted-legacy" || lifecycle === "superseded";
}

/**
 * True for a record that CLAIMS to be accepted, whether or not the claim
 * holds: it is the population whose edges must be treated as uncertain when
 * the claim fails, because a reader cannot tell a forged edge from an edge
 * whose evidence was damaged after the fact.
 */
export function claimsAcceptance(ruling: Ruling): boolean {
  return ruling.status === undefined || ruling.status === "accepted";
}

/**
 * The alternatives a conflicted record carries: the record's own body and
 * every `ours`/`theirs` side that parses as a ruling. Each is classified on
 * its own so a conflict between two acceptance claims taints both edges,
 * while a conflict between two malformed proposals taints nothing.
 */
export function conflictAlternatives(ruling: Ruling): Ruling[] {
  const { _conflicts, ...body } = ruling as Ruling & { _conflicts?: unknown };
  const out: Ruling[] = [];
  const own = RulingSchema.safeParse(body);
  if (own.success) out.push(own.data);
  if (!Array.isArray(_conflicts)) return out;
  for (const entry of _conflicts) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const side of ["ours", "theirs"] as const) {
      const alt = (entry as Record<string, unknown>)[side];
      if (typeof alt !== "object" || alt === null || Array.isArray(alt)) continue;
      const parsed = RulingSchema.safeParse({ ...(alt as Record<string, unknown>), _conflicts: undefined });
      if (parsed.success) out.push(parsed.data);
    }
  }
  return out;
}

/** The full lifecycle, `superseded` included, given an index whose authoritative successors are known. */
export function lifecycleOf(
  ruling: Ruling,
  index: { readonly successorsByTarget: ReadonlyMap<string, readonly string[]> },
): RulingLifecycle {
  const base = classifyLifecycle(ruling).lifecycle;
  if (!isEffectivelyAccepted(base)) return base;
  return (index.successorsByTarget.get(ruling.id)?.length ?? 0) > 0 ? "superseded" : base;
}

/** Proposals (lifecycle exactly `proposed`) that name `itemId` in `proposedFor`. */
export function proposalsFor(rulings: readonly Ruling[], itemId: string): Ruling[] {
  return rulings.filter((r) => classifyLifecycle(r).lifecycle === "proposed" && (r.proposedFor ?? []).includes(itemId));
}

/** Proposals (lifecycle exactly `proposed`) whose `proposesToSupersede` names `targetId`. */
export function proposalsAgainst(rulings: readonly Ruling[], targetId: string): Ruling[] {
  return rulings.filter((r) => classifyLifecycle(r).lifecycle === "proposed" && r.proposesToSupersede === targetId);
}
