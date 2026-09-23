import type { ProjectState } from "./project-state.js";
import { ProjectLoaderError } from "./errors.js";

export interface ConflictedItem {
  type: "ticket" | "issue" | "note" | "lesson" | "config" | "roadmap" | "arrangement" | "ruling" | CatalogConflictType;
  id: string;
  conflictCount: number;
}

/** T-529: the two catalog files, by the type `conflicts list` prints. */
export type CatalogConflictType = "capabilities" | "glossary";

/** The id a catalog is reported and addressed under: its file name. */
export const CATALOG_CONFLICT_IDS: Readonly<Record<CatalogConflictType, string>> = {
  capabilities: "capabilities.json",
  glossary: "glossary.json",
};

/** One catalog document as the conflict report reads it: only its own `_conflicts`. */
export interface CatalogConflictSource {
  readonly type: CatalogConflictType;
  readonly _conflicts?: unknown;
}

/** One report item per catalog carrying open records. */
export function catalogConflictItems(catalogs: readonly CatalogConflictSource[]): ConflictedItem[] {
  const items: ConflictedItem[] = [];
  for (const catalog of catalogs) {
    if (Array.isArray(catalog._conflicts) && catalog._conflicts.length > 0) {
      items.push({ type: catalog.type, id: CATALOG_CONFLICT_IDS[catalog.type], conflictCount: catalog._conflicts.length });
    }
  }
  return items;
}

export interface ConflictsReport {
  hasConflicts: boolean;
  items: ConflictedItem[];
}

/**
 * `arrangements` is optional and additive-only: arrangements are not on
 * `ProjectState` (T-473 binding item 2 keeps them off the strict load path),
 * so this is the only way `storybloq conflicts` can see one. `assertNoConflicts`
 * below deliberately does NOT gain this parameter -- that would route
 * arrangement conflicts through the write-blocking assertion nearly every
 * ordinary ticket/issue/note/lesson write goes through, violating the same
 * binding item. `rulings` (T-522) is the same additive shape for the same
 * reason: rulings load through `loadRulingsSafe`, not `ProjectState`.
 * `catalogs` (T-529) is the same again: the capability inventory and the
 * glossary load through their own catalog, and an open record there already
 * refuses that file's ordinary writes (`catalog.ts` transact), so routing it
 * through `assertNoConflicts` would only block unrelated ledger writes.
 */
export function hasConflicts(
  state: ProjectState,
  arrangements?: readonly { id: string; _conflicts?: unknown[] }[],
  rulings?: readonly { id: string; _conflicts?: unknown[] }[],
  catalogs?: readonly CatalogConflictSource[],
): ConflictsReport {
  const items: ConflictedItem[] = [];

  function scan(collection: readonly { id: string }[], type: ConflictedItem["type"]): void {
    for (const item of collection) {
      const conflicts = (item as Record<string, unknown>)._conflicts;
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        items.push({ type, id: item.id, conflictCount: conflicts.length });
      }
    }
  }

  scan(state.tickets, "ticket");
  scan(state.issues, "issue");
  scan(state.notes, "note");
  scan(state.lessons, "lesson");
  if (arrangements) scan(arrangements, "arrangement");
  if (rulings) scan(rulings, "ruling");

  const configConflicts = (state.config as Record<string, unknown>)._conflicts;
  if (Array.isArray(configConflicts) && configConflicts.length > 0) {
    items.push({ type: "config", id: "config.json", conflictCount: configConflicts.length });
  }
  const roadmapConflicts = (state.roadmap as Record<string, unknown>)._conflicts;
  if (Array.isArray(roadmapConflicts) && roadmapConflicts.length > 0) {
    items.push({ type: "roadmap", id: "roadmap.json", conflictCount: roadmapConflicts.length });
  }
  if (catalogs) items.push(...catalogConflictItems(catalogs));

  return { hasConflicts: items.length > 0, items };
}

export function assertNoConflicts(state: ProjectState): void {
  const report = hasConflicts(state);
  if (!report.hasConflicts) return;
  const summary = report.items.map((i) => `${i.id} (${i.conflictCount})`).join(", ");
  throw new ProjectLoaderError(
    "conflict",
    `Cannot write: ${report.items.length} item(s) have unresolved conflicts: ${summary}. ` +
    `Run \`storybloq conflicts list\` to inspect, then \`storybloq resolve <id> --use ours|theirs\`. ` +
    `For config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`.`,
  );
}
