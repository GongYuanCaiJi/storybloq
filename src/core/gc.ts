import type { ProjectState } from "./project-state.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";

export interface GcCandidate {
  type: "ticket" | "issue" | "note" | "lesson";
  id: string;
  deletedAt: string;
  deletedBy: string;
  age: number;
  activeReferences: string[];
}

export interface GcPlan {
  candidates: GcCandidate[];
  blocked: GcCandidate[];
  eligible: GcCandidate[];
  warnings: string[];
  retentionDays: number;
}

export interface GcOptions {
  retentionDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeGcPlan(state: ProjectState, options?: GcOptions): GcPlan {
  const retentionDays = options?.retentionDays ?? 30;
  const now = Date.now();
  const candidates: GcCandidate[] = [];
  const warnings: string[] = [];

  const activeTickets = new Set(state.activeTickets.map((t) => t.id));
  const activeIssues = new Set(state.activeIssues.map((i) => i.id));

  function collectDeleted(
    items: readonly { id: string }[],
    type: GcCandidate["type"],
  ): void {
    for (const item of items) {
      const rec = item as Record<string, unknown>;
      if (rec.lifecycle !== "deleted") continue;

      const deletedAt = rec.deletedAt as string | undefined;
      if (!deletedAt || typeof deletedAt !== "string") {
        warnings.push(`${item.id}: missing deletedAt`);
        continue;
      }

      const ts = Date.parse(deletedAt);
      if (Number.isNaN(ts)) {
        warnings.push(`${item.id}: invalid deletedAt "${deletedAt}"`);
        continue;
      }

      if (ts > now) {
        warnings.push(`${item.id}: future deletedAt "${deletedAt}"`);
        continue;
      }

      const age = Math.floor((now - ts) / MS_PER_DAY);
      if (age < retentionDays) continue;

      candidates.push({
        type,
        id: item.id,
        deletedAt,
        deletedBy: (rec.deletedBy as string) ?? "unknown",
        age,
        activeReferences: [],
      });
    }
  }

  collectDeleted(state.tickets, "ticket");
  collectDeleted(state.issues, "issue");
  collectDeleted(state.notes, "note");
  collectDeleted(state.lessons, "lesson");

  const candidateIds = new Set(candidates.map((c) => c.id));
  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const candidateByRef = new Map<string, GcCandidate>();
  for (const c of candidates) {
    candidateByRef.set(c.id, c);
    const rec = (state.tickets as readonly Record<string, unknown>[]).find((t) => t.id === c.id)
      ?? (state.issues as readonly Record<string, unknown>[]).find((i) => i.id === c.id)
      ?? (state.notes as readonly Record<string, unknown>[]).find((n) => n.id === c.id)
      ?? (state.lessons as readonly Record<string, unknown>[]).find((l) => l.id === c.id);
    if (rec) {
      if (typeof rec.displayId === "string") candidateByRef.set(rec.displayId, c);
      if (Array.isArray(rec.previousDisplayIds)) {
        for (const prev of rec.previousDisplayIds) {
          if (typeof prev === "string") candidateByRef.set(prev, c);
        }
      }
    }
  }

  function findCandidate(ref: string): GcCandidate | undefined {
    return candidateByRef.get(ref);
  }

  for (const t of state.tickets as readonly Ticket[]) {
    if (candidateIds.has(t.id)) continue;
    for (const bid of t.blockedBy) {
      const c = findCandidate(bid);
      if (c) c.activeReferences.push(t.id);
    }
    if (t.parentTicket) {
      const c = findCandidate(t.parentTicket);
      if (c) c.activeReferences.push(t.id);
    }
  }

  for (const i of state.issues as readonly Issue[]) {
    if (candidateIds.has(i.id)) continue;
    for (const tref of i.relatedTickets) {
      const c = findCandidate(tref);
      if (c) c.activeReferences.push(i.id);
    }
  }

  const blocked = candidates.filter((c) => c.activeReferences.length > 0);
  const eligible = candidates.filter((c) => c.activeReferences.length === 0);

  return { candidates, blocked, eligible, warnings, retentionDays };
}
