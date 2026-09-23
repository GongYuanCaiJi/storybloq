import type { CatalogInvariantRule } from "./types.js";

/**
 * T-529: a cross-entry collision in a catalog document, in the one shape the
 * three consumers share: the document schema (which refuses it), the merge
 * driver's post-merge pass (which records it), and the resolver's incremental
 * rule (which compares the collisions before and after a repair). Each catalog
 * model computes its own list; nothing restates the rule that finds them.
 */
export interface CatalogInvariantViolation {
  readonly rule: CatalogInvariantRule;
  /** The normalised value two or more entries claim. */
  readonly key: string;
  /** Every entry claiming it, distinct and sorted, so two runs agree byte for byte. */
  readonly entityIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `record` is an unresolved `invariant` conflict that names this
 * collision: the same rule, the same key, and EVERY colliding entry. A record
 * naming only some of them does not cover the collision, so a later write that
 * adds a third claimant is a new violation rather than one already recorded.
 */
export function recordCoversViolation(record: unknown, violation: CatalogInvariantViolation): boolean {
  if (!isRecord(record) || record.kind !== "invariant") return false;
  if (record.rule !== violation.rule || record.key !== violation.key) return false;
  const named = record.entityIds;
  if (!Array.isArray(named)) return false;
  return violation.entityIds.every((id) => named.includes(id));
}

/**
 * Whether a document's own `_conflicts` records this collision. The schemas
 * use it to tolerate exactly the collisions a merge recorded: without that,
 * the loader would refuse the merged file before `resolve` could open it, and
 * the merge driver's output gate (which validates with the loader's schema)
 * would discard the record for a whole-document fallback.
 */
export function isViolationRecorded(conflicts: unknown, violation: CatalogInvariantViolation): boolean {
  return Array.isArray(conflicts) && conflicts.some((c) => recordCoversViolation(c, violation));
}

/** Groups pairwise collisions into one violation per key, entity ids distinct and sorted. */
export function groupViolations(
  rule: CatalogInvariantRule,
  pairs: ReadonlyArray<{ readonly key: string; readonly ids: readonly string[] }>,
): CatalogInvariantViolation[] {
  const byKey = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const ids = byKey.get(pair.key) ?? new Set<string>();
    for (const id of pair.ids) ids.add(id);
    byKey.set(pair.key, ids);
  }
  return [...byKey.entries()].map(([key, ids]) => ({ rule, key, entityIds: [...ids].sort() }));
}
