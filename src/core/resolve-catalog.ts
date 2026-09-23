/**
 * T-529: the catalog-only half of `resolve`: the invariant resolvers and the
 * incremental rule every catalog resolution passes before it is written.
 *
 * An `invariant` record names a word (or a capability name) that two or more
 * entries claim. It is resolved by changing the entries, never by choosing a
 * side: `--rename` gives one claimant another value, `--drop-alias` removes a
 * term's colliding alias, `--keep` keeps one term and deletes the others.
 *
 * THE INCREMENTAL RULE. A resolution may only take collisions away. The
 * collisions before and after the change are compared: one the file did not
 * have before (a new key, or an entry newly joining a key) is refused and
 * named. Every invariant record is then brought in line with what is left: a
 * record whose collision is gone is consumed; a record whose collision now
 * spans fewer of its entries is narrowed to those entries and stays open
 * (so three claimants renamed one at a time end with the record gone). That
 * narrowing is what "gone" means for a record with more than two claimants.
 */

import type { ConflictEntry } from "../models/types.js";
import type { CatalogInvariantViolation } from "../models/catalog-invariant.js";
import { normalizeTermKey, termOwnerViolations } from "../models/glossary.js";
import { normalizeCapabilityName, capabilityNameViolations } from "../models/capability.js";
import type { ResolveResult } from "./resolve.js";

export type CatalogKey = "capabilities" | "terms";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesOf(doc: Record<string, unknown>, key: CatalogKey): unknown[] {
  const arr = doc[key];
  return Array.isArray(arr) ? arr : [];
}

/** The collisions a catalog document holds now, by the model's own rule. */
export function catalogViolations(doc: Record<string, unknown>, key: CatalogKey): CatalogInvariantViolation[] {
  const entries = entriesOf(doc, key);
  return key === "terms" ? termOwnerViolations(entries) : capabilityNameViolations(entries);
}

/** Same rule, same key, and every entry of `inner` among `outer`'s. */
function within(outer: { rule?: unknown; key?: unknown; entityIds?: unknown }, inner: CatalogInvariantViolation): boolean {
  if (outer.rule !== inner.rule || outer.key !== inner.key) return false;
  const ids = outer.entityIds;
  return Array.isArray(ids) && inner.entityIds.every((id) => ids.includes(id));
}

function describe(v: CatalogInvariantViolation): string {
  return `${v.rule} ${JSON.stringify(v.key)} (${v.entityIds.join(", ")})`;
}

/** Refuses any collision `after` holds that no collision `before` covers. */
export function assertNoNewCollision(
  before: readonly CatalogInvariantViolation[],
  after: readonly CatalogInvariantViolation[],
  file: string,
): void {
  const fresh = after.filter((a) => !before.some((b) => within(b, a)));
  if (fresh.length > 0) {
    throw new Error(
      `Cannot resolve: the result would add a collision ${file} does not have: ${fresh.map(describe).join("; ")}. ` +
      `Choose another value, or resolve by hand.`,
    );
  }
}

/**
 * Brings every invariant record in line with the collisions left after a
 * write: consumed when its collision is gone, narrowed when fewer of its
 * entries still collide, unchanged otherwise. Returns the new record list and
 * what changed, for the output.
 */
export function syncInvariantRecords(
  conflicts: readonly ConflictEntry[],
  after: readonly CatalogInvariantViolation[],
): { conflicts: ConflictEntry[]; consumed: ConflictEntry[]; narrowed: ConflictEntry[] } {
  const kept: ConflictEntry[] = [];
  const consumed: ConflictEntry[] = [];
  const narrowed: ConflictEntry[] = [];
  for (const c of conflicts) {
    if (c.kind !== "invariant") {
      kept.push(c);
      continue;
    }
    const left = after.find((v) => within(c, v));
    if (!left) {
      consumed.push(c);
      continue;
    }
    if (left.entityIds.length < (c.entityIds ?? []).length) {
      const next = { ...c, entityIds: [...left.entityIds] };
      narrowed.push(next);
      kept.push(next);
      continue;
    }
    kept.push(c);
  }
  return { conflicts: kept, consumed, narrowed };
}

export type InvariantAction =
  | { readonly kind: "rename"; readonly id: string; readonly value: string }
  | { readonly kind: "drop-alias"; readonly id: string; readonly alias: string }
  | { readonly kind: "keep"; readonly id: string };

export interface InvariantScope {
  readonly file: string;
  readonly key: CatalogKey;
  /** Throws to refuse deleting a term a capability references (called inside the lock). */
  readonly guardDelete: (entryId: string) => void;
  /** The timestamp an edited term's updatedAt gets. */
  readonly now: () => string;
}

function flagOf(action: InvariantAction): string {
  return action.kind === "rename" ? "--rename" : action.kind === "drop-alias" ? "--drop-alias" : "--keep";
}

/** Applies the action to the entry array; returns the ids it deleted (only --keep deletes). */
function applyAction(
  doc: Record<string, unknown>,
  record: ConflictEntry,
  action: InvariantAction,
  scope: InvariantScope,
): string[] {
  const entries = entriesOf(doc, scope.key);
  const index = entries.findIndex((el) => isPlainObject(el) && el.id === action.id);
  if (index < 0) {
    throw new Error(`Cannot resolve: entry "${action.id}" is not in ${scope.file}. Resolve by hand.`);
  }
  const key = String(record.key);
  const entry = { ...(entries[index] as Record<string, unknown>) };
  const next = [...entries];

  if (action.kind === "keep") {
    // The record says who claimed the word at merge time; the deletions come
    // from who claims it NOW. An id the record names that no longer claims
    // the word is not deleted, and a keeper that no longer claims it is refused.
    const current = catalogViolations(doc, scope.key).find((v) => v.rule === record.rule && v.key === record.key);
    if (!current || !current.entityIds.includes(action.id)) {
      throw new Error(`Cannot resolve: "${action.id}" no longer claims ${JSON.stringify(key)}, so it cannot be the one kept. Resolve by hand.`);
    }
    if (!within(record, current)) {
      throw new Error(
        `Cannot resolve: ${JSON.stringify(key)} is now claimed by ${current.entityIds.join(", ")}, not only by the entries the record names. Resolve by hand.`,
      );
    }
    const others = current.entityIds.filter((id) => id !== action.id);
    for (const id of others) scope.guardDelete(id);
    doc[scope.key] = next.filter((el) => !(isPlainObject(el) && typeof el.id === "string" && others.includes(el.id)));
    return others;
  }

  if (scope.key === "capabilities") {
    // Only --rename reaches here for a capability (checked by the caller).
    if (typeof entry.name !== "string" || normalizeCapabilityName(entry.name) !== key) {
      throw new Error(`Cannot resolve: the name of "${action.id}" is not the colliding name ${JSON.stringify(key)} any more. Resolve by hand.`);
    }
    entry.name = (action as Extract<InvariantAction, { kind: "rename" }>).value;
  } else if (action.kind === "rename") {
    if (typeof entry.term === "string" && normalizeTermKey(entry.term) === key) {
      entry.term = action.value;
    } else {
      const aliases = Array.isArray(entry.aliases) ? [...(entry.aliases as unknown[])] : [];
      const at = aliases.findIndex((a) => typeof a === "string" && normalizeTermKey(a) === key);
      if (at < 0) {
        throw new Error(`Cannot resolve: "${action.id}" no longer claims ${JSON.stringify(key)}. Resolve by hand.`);
      }
      aliases[at] = action.value;
      entry.aliases = aliases;
    }
    entry.updatedAt = scope.now();
  } else {
    if (normalizeTermKey(action.alias) !== key) {
      throw new Error(`Cannot resolve: the alias ${JSON.stringify(action.alias)} is not the colliding word ${JSON.stringify(key)}.`);
    }
    const aliases = Array.isArray(entry.aliases) ? (entry.aliases as unknown[]) : [];
    if (!aliases.includes(action.alias)) {
      throw new Error(`Cannot resolve: ${JSON.stringify(action.alias)} is not an alias of "${action.id}" (to change its term, use --rename).`);
    }
    const left = aliases.filter((a) => a !== action.alias);
    if (left.length === 0) delete entry.aliases;
    else entry.aliases = left;
    entry.updatedAt = scope.now();
  }
  next[index] = entry;
  doc[scope.key] = next;
  return [];
}

/**
 * `resolve <catalog> --invariant <n> --rename|--drop-alias|--keep`. `n` is
 * the 1-based ordinal `conflicts show` prints for invariant records.
 */
export function resolveCatalogInvariant(
  doc: Record<string, unknown>,
  ordinal: number,
  action: InvariantAction,
  scope: InvariantScope,
): ResolveResult {
  const conflicts = (doc._conflicts as ConflictEntry[] | undefined) ?? [];
  const invariants = conflicts.filter((c) => c.kind === "invariant");
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > invariants.length) {
    throw new Error(
      `${scope.file} has no invariant conflict ${ordinal} (it has ${invariants.length}); ` +
      `\`storybloq conflicts show ${scope.file}\` numbers them.`,
    );
  }
  const record = invariants[ordinal - 1]!;
  const ids = record.entityIds ?? [];
  const expectedRule = scope.key === "terms" ? "term-owner" : "capability-name";
  if (record.rule !== expectedRule) {
    throw new Error(`Cannot resolve: invariant ${ordinal} is a ${String(record.rule)} record, which does not belong in ${scope.file}. Resolve by hand.`);
  }
  if (!ids.includes(action.id)) {
    throw new Error(`Entry "${action.id}" is not named by invariant ${ordinal} (it names ${ids.join(", ")}).`);
  }
  if (record.rule === "capability-name" && action.kind !== "rename") {
    throw new Error(
      `${flagOf(action)} applies to a word terms claim. A capability name collision is resolved with --rename <id> <new name>; ` +
      `a resolution never deletes a capability.`,
    );
  }

  const before = catalogViolations(doc, scope.key);
  const deleted = applyAction(doc, record, action, scope);
  const after = catalogViolations(doc, scope.key);

  const persisting = after.find((v) => within(record, v));
  if (persisting && persisting.entityIds.length === ids.length) {
    throw new Error(
      `Cannot resolve: after ${flagOf(action)} every entry invariant ${ordinal} names still claims ${JSON.stringify(record.key)}. ` +
      `Choose a value that normalises differently.`,
    );
  }
  assertNoNewCollision(before, after, scope.file);

  const messages: string[] = [];
  let remaining = conflicts;
  if (deleted.length > 0) {
    // A deleted entry's own records describe nothing any more.
    const dangling = remaining.filter((c) => c.kind !== "invariant" && c.entityId !== undefined && deleted.includes(c.entityId));
    if (dangling.length > 0) {
      remaining = remaining.filter((c) => !dangling.includes(c));
      messages.push(`Dropped ${dangling.length} record(s) that named the deleted term(s) ${deleted.join(", ")}.`);
    }
    messages.push(`Deleted ${deleted.join(", ")}; kept ${action.id}.`);
  }
  const synced = syncInvariantRecords(remaining, after);
  for (const c of synced.narrowed) {
    messages.push(`Invariant ${JSON.stringify(c.key)} narrowed, ${(c.entityIds ?? []).length} claimants remain: ${(c.entityIds ?? []).join(", ")}.`);
  }
  const alsoConsumed = synced.consumed.filter((c) => c !== record);
  if (alsoConsumed.length > 0) {
    messages.push(`${alsoConsumed.length} other invariant record(s) no longer describe a collision and were cleared.`);
  }

  if (synced.conflicts.length === 0) delete doc._conflicts;
  else doc._conflicts = synced.conflicts;
  return {
    resolved: [`invariant ${ordinal}`],
    remaining: synced.conflicts.length,
    fullyResolved: synced.conflicts.length === 0,
    warnings: [],
    messages,
  };
}
