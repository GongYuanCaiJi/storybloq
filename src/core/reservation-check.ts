import { execFileSync } from "node:child_process";
import type { ProjectState } from "./project-state.js";

export interface ReservationTagResult {
  tags: Map<string, Set<string>>;
  fetchError?: string;
}

export interface ReservationHealth {
  valid: Map<string, Set<string>>;
  orphan: Map<string, Set<string>>;
}

const TAG_PREFIX = "storybloq/ids/";

const TYPE_MAP: Record<string, string> = {
  tickets: "ticket",
  issues: "issue",
  notes: "note",
  lessons: "lesson",
};

function parseTag(tagName: string): { entityType: string; displayId: string } | null {
  if (!tagName.startsWith(TAG_PREFIX)) return null;
  const rest = tagName.substring(TAG_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  const plural = rest.substring(0, slashIdx);
  const displayId = rest.substring(slashIdx + 1);
  const entityType = TYPE_MAP[plural];
  if (!entityType || !displayId) return null;
  return { entityType, displayId };
}

export function fetchLocalReservationTags(root: string): ReservationTagResult {
  const tags = new Map<string, Set<string>>();

  try {
    const stdout = execFileSync("git", ["tag", "-l", "storybloq/ids/*"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!stdout) return { tags };

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseTag(trimmed);
      if (!parsed) continue;
      let set = tags.get(parsed.entityType);
      if (!set) {
        set = new Set();
        tags.set(parsed.entityType, set);
      }
      set.add(parsed.displayId);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { tags, fetchError: message };
  }

  return { tags };
}

function effectiveDisplayIds(items: readonly { id: string; displayId?: string | null }[]): Set<string> {
  const set = new Set<string>();
  for (const item of items) {
    set.add(item.displayId ?? item.id);
  }
  return set;
}

export function classifyReservations(
  tags: Map<string, Set<string>>,
  state: ProjectState,
): ReservationHealth {
  const valid = new Map<string, Set<string>>();
  const orphan = new Map<string, Set<string>>();

  const itemsByType: Record<string, readonly { id: string; displayId?: string | null }[]> = {
    ticket: state.tickets,
    issue: state.issues,
    note: state.notes,
    lesson: state.lessons,
  };

  for (const [entityType, reservedIds] of tags) {
    const items = itemsByType[entityType];
    if (!items) continue;

    const existingIds = effectiveDisplayIds(items);
    const validSet = new Set<string>();
    const orphanSet = new Set<string>();

    for (const displayId of reservedIds) {
      if (existingIds.has(displayId)) {
        validSet.add(displayId);
      } else {
        orphanSet.add(displayId);
      }
    }

    if (validSet.size > 0) valid.set(entityType, validSet);
    if (orphanSet.size > 0) orphan.set(entityType, orphanSet);
  }

  return { valid, orphan };
}
