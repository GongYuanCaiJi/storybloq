/**
 * Canonical `_conflicts` lifecycle shared by threeWayMerge, mergeConfig and
 * mergeRoadmap (ISS-750).
 *
 * States are structural: an entry PRESENT in the `_conflicts` array is OPEN;
 * an entry REMOVED is RESOLVED (the chosen value lives in the body). Merge-time
 * lifecycle is derived from three-way set membership: an entry present in the
 * merge base but absent from a side means that side resolved it.
 *
 * SEMANTIC COMMITMENT: hand-deleting a `_conflicts` block on one side counts as
 * resolution, and the entry drops on the next merge. This is standard three-way
 * semantics and the only way resolution is durable; safety rests on the
 * ordinary field merge re-detecting genuine content divergence, which emits a
 * fresh entry.
 *
 * This module must stay dependency-free (no imports from project-loader or the
 * models) so core merge-driver can use it without dragging in the loader.
 */

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 * Keys whose value is `undefined` are omitted (matching a JSON round-trip);
 * `undefined` array elements serialize as null (JSON semantics). This makes
 * instanceKey identical whether computed on parsed-JSON or in-memory entries.
 */
function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * "Which field does this conflict occupy." Same string as the merge driver's
 * historical dedup key. Used only for fresh-supersedes-stale and the final
 * carried-survivor dedup.
 */
export function slotKey(c: Record<string, unknown>): string {
  return `${c.fieldPath}\0${c.kind}\0${c.group ?? ""}`;
}

/**
 * Deterministic content identity of a conflict entry. Two clones running the
 * identical merge emit byte-identical entries, so criss-cross merges dedup
 * naturally; a NEW unresolved entry never matches an OLD resolved entry on the
 * same slot because the recorded values differ.
 */
export function instanceKey(c: Record<string, unknown>): string {
  return stableStringify({
    fieldPath: c.fieldPath,
    field: c.field,
    kind: c.kind,
    group: c.group,
    base: c.base,
    ours: c.ours,
    theirs: c.theirs,
  });
}

function extractConflicts(doc: Record<string, unknown>): Record<string, unknown>[] {
  const raw = doc._conflicts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is Record<string, unknown> => typeof c === "object" && c !== null && !Array.isArray(c),
  );
}

/**
 * Three-way "delete-wins" set semantics on instanceKey over the `_conflicts`
 * arrays of the three ORIGINAL UNSTRIPPED documents (the module extracts
 * `._conflicts` itself, leniently: missing/non-array values contribute the
 * empty set and non-object elements are ignored, I6).
 *
 * Per instanceKey:
 * - in base + both sides  -> keep (ours' copy): unresolved on both sides
 * - in base + one side    -> drop: the other side resolved it
 * - in base only          -> drop: both sides resolved it
 * - not in base           -> keep: that side concluded its own earlier
 *   conflicted merge (kept once when both sides carry the identical entry)
 *
 * FINAL STEP (R2): all carried survivors are deduped by slotKey, keeping the
 * ours-side copy (the copy whose source set included oursDoc; if only theirs
 * contributed, theirs' copy is kept). In the opposite-direction criss-cross
 * case the two survivors carry the same three values with swapped ours/theirs
 * labels, so dropping the theirs-labeled copy loses no content, only a
 * labeling duplicate. This pass also collapses an ours-sourced and a
 * theirs-only copy with DIFFERENT content on the same slot; that is safe
 * because a genuinely divergent body emits a fresh entry that supersedes the
 * slot (see mergeConflictSets).
 */
export function carryForward(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown>[] {
  const baseKeys = new Set(extractConflicts(base).map(instanceKey));
  const oursEntries = extractConflicts(ours);
  const theirsEntries = extractConflicts(theirs);
  const theirsKeys = new Set(theirsEntries.map(instanceKey));

  const survivors: Array<{ entry: Record<string, unknown>; fromOurs: boolean }> = [];
  const seen = new Set<string>();

  for (const entry of oursEntries) {
    const key = instanceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    // In base: unresolved only if theirs still carries it too.
    if (baseKeys.has(key) && !theirsKeys.has(key)) continue;
    survivors.push({ entry, fromOurs: true });
  }

  for (const entry of theirsEntries) {
    const key = instanceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    // In base but absent from ours: ours resolved it.
    if (baseKeys.has(key)) continue;
    survivors.push({ entry, fromOurs: false });
  }

  // R2: slot-level dedup of survivors, ours-first.
  const bySlot = new Map<string, { entry: Record<string, unknown>; fromOurs: boolean }>();
  const slotOrder: string[] = [];
  for (const s of survivors) {
    const slot = slotKey(s.entry);
    const existing = bySlot.get(slot);
    if (!existing) {
      bySlot.set(slot, s);
      slotOrder.push(slot);
    } else if (!existing.fromOurs && s.fromOurs) {
      bySlot.set(slot, s);
    }
  }
  return slotOrder.map((slot) => bySlot.get(slot)!.entry);
}

/**
 * Combines carried entries with the conflicts freshly emitted by the current
 * merge. Fresh entries REPLACE carried entries occupying the same slotKey:
 * stale values from an earlier merge are superseded by current ones. Output:
 * surviving carried entries first, then fresh entries.
 */
export function mergeConflictSets(
  carried: Record<string, unknown>[],
  fresh: Array<Record<string, unknown> | object>,
): unknown[] {
  const freshEntries = fresh as Record<string, unknown>[];
  const freshSlots = new Set(freshEntries.map(slotKey));
  const survivingCarried = carried.filter((c) => !freshSlots.has(slotKey(c)));
  return [...survivingCarried, ...freshEntries];
}

/**
 * Attaches the final conflict set to the merged document: `_conflicts` is set
 * when non-empty and removed entirely when empty (presence IS the open state).
 */
export function attachConflicts(merged: Record<string, unknown>, entries: unknown[]): void {
  if (entries.length > 0) {
    merged._conflicts = entries;
  } else {
    delete merged._conflicts;
  }
}
