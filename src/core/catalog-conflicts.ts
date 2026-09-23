/**
 * T-529: what a catalog document's own `_conflicts` says about its entries.
 *
 * The merge driver records a catalog conflict by the entry it belongs to
 * (`entityId`), and a cross-entry collision by every entry involved
 * (`entityIds` on an `invariant` record). Every reader that must not treat a
 * conflicted entry as settled (the capability check, `match`, a stamp, the
 * brief, the knowledge review, `validate`) derives its view from this one
 * function, so no reader re-decides which records name which entries.
 *
 * Kept to a leaf import on purpose: `catalog.ts` uses it to word its refusal.
 */

import { sanitizeDisplayText } from "./display-text.js";

/** How many entry ids a refusal names before it counts the rest. */
const NAMED_IDS_CAP = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The whole-document fallback record the driver writes when no structural merge was loadable. */
export function isWholeDocumentRecord(record: Record<string, unknown>): boolean {
  return record.field === "_entity" || record.fieldPath === "";
}

export interface CatalogConflictScope {
  /** Unresolved records of every kind. Zero means the file is clear. */
  readonly total: number;
  /**
   * Entries an unresolved field, group or element record names. Every entry
   * when a whole-document fallback record is open: that file's body is one
   * side's, the other side's entries survive only in the record's snapshots,
   * and nothing in it can be read as settled.
   */
  readonly conflictedIds: ReadonlySet<string>;
  /** Entries an unresolved `invariant` record names. */
  readonly problemIds: ReadonlySet<string>;
  /** Every entry either set names, with the reason a reader prints. */
  readonly excluded: ReadonlyMap<string, string>;
  /** True when a whole-document fallback record is open. */
  readonly wholeDocument: boolean;
  /** Open records that name no entry: a version, an order, the whole document. */
  readonly documentRecords: number;
}

export const CONFLICTED_REASON = "an unresolved merge conflict names this entry";
export const INVARIANT_REASON = "an unresolved invariant conflict names this entry";

export function catalogConflictScope(
  doc: { readonly _conflicts?: unknown },
  entryIds: readonly string[],
): CatalogConflictScope {
  const records = Array.isArray(doc._conflicts) ? doc._conflicts.filter(isRecord) : [];
  const conflictedIds = new Set<string>();
  const problemIds = new Set<string>();
  let wholeDocument = false;
  let documentRecords = 0;
  for (const record of records) {
    if (record.kind === "invariant") {
      if (Array.isArray(record.entityIds)) {
        for (const id of record.entityIds) if (typeof id === "string") problemIds.add(id);
      }
      continue;
    }
    if (typeof record.entityId === "string") {
      conflictedIds.add(record.entityId);
      continue;
    }
    documentRecords += 1;
    if (isWholeDocumentRecord(record)) wholeDocument = true;
  }
  if (wholeDocument) for (const id of entryIds) conflictedIds.add(id);
  const excluded = new Map<string, string>();
  for (const id of conflictedIds) excluded.set(id, CONFLICTED_REASON);
  for (const id of problemIds) if (!excluded.has(id)) excluded.set(id, INVARIANT_REASON);
  return { total: records.length, conflictedIds, problemIds, excluded, wholeDocument, documentRecords };
}

/**
 * The refusal an ordinary catalog write gives while the file carries an open
 * conflict, naming what is open and where to look. `resolve` is the only
 * writer until the file is clear: a write in between would change an entry a
 * record describes, so the record would no longer describe the file.
 */
export function openConflictRefusal(file: string, doc: { readonly _conflicts?: unknown }): string | null {
  const scope = catalogConflictScope(doc, []);
  if (scope.total === 0) return null;
  // The ids come from the file, which a merge wrote from someone's branch:
  // each is made safe to print, and the list is bounded.
  const named = [...new Set([...scope.conflictedIds, ...scope.problemIds])].sort();
  const shown = named.slice(0, NAMED_IDS_CAP).map((id) => sanitizeDisplayText(id));
  const more = named.length > NAMED_IDS_CAP ? ` and ${named.length - NAMED_IDS_CAP} more` : "";
  const parts: string[] = [];
  if (named.length > 0) parts.push(`entries ${shown.join(", ")}${more}`);
  if (scope.wholeDocument) parts.push("the whole document");
  else if (scope.documentRecords > 0) parts.push(`${scope.documentRecords} document-level record(s)`);
  return (
    `Cannot write ${file}: it has ${scope.total} unresolved merge conflict(s) (${parts.join("; ")}). ` +
    `Run \`storybloq conflicts show ${file}\` to inspect; until they are resolved, \`storybloq resolve\` is the only writer of this file.`
  );
}
