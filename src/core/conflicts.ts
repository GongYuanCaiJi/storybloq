import type { ProjectState } from "./project-state.js";
import { ProjectLoaderError } from "./errors.js";

export interface ConflictedItem {
  type: "ticket" | "issue" | "note" | "lesson";
  id: string;
  conflictCount: number;
}

export interface ConflictsReport {
  hasConflicts: boolean;
  items: ConflictedItem[];
}

export function hasConflicts(state: ProjectState): ConflictsReport {
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

  return { hasConflicts: items.length > 0, items };
}

export function assertNoConflicts(state: ProjectState): void {
  const report = hasConflicts(state);
  if (!report.hasConflicts) return;
  const summary = report.items.map((i) => `${i.id} (${i.conflictCount})`).join(", ");
  throw new ProjectLoaderError(
    "conflicts_present",
    `Cannot write: ${report.items.length} item(s) have unresolved conflicts: ${summary}. Run \`storybloq resolve\` first.`,
  );
}
