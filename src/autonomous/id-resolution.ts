import type { ProjectState } from "../core/project-state.js";
import { TICKET_CANONICAL_ID_REGEX, ISSUE_CANONICAL_ID_REGEX, TICKET_ID_REGEX, ISSUE_ID_REGEX } from "../models/types.js";

export interface WorkIdResolution {
  canonicalId: string;
  displayId: string;
}

export function resolveWorkId(id: string, state: ProjectState): WorkIdResolution {
  const isTicketLike = TICKET_ID_REGEX.test(id) || TICKET_CANONICAL_ID_REGEX.test(id);
  const isIssueLike = ISSUE_ID_REGEX.test(id) || ISSUE_CANONICAL_ID_REGEX.test(id);

  if (isTicketLike) {
    const result = state.resolveTicketRef(id);
    if (result.kind === "found") {
      const item = result.item as Record<string, unknown>;
      return {
        canonicalId: result.item.id,
        displayId: (item.displayId as string) ?? result.item.id,
      };
    }
  }

  if (isIssueLike) {
    const result = state.resolveIssueRef(id);
    if (result.kind === "found") {
      const item = result.item as Record<string, unknown>;
      return {
        canonicalId: result.item.id,
        displayId: (item.displayId as string) ?? result.item.id,
      };
    }
  }

  return { canonicalId: id, displayId: id };
}

export function resolveDisplayId(id: string, state: ProjectState): string {
  return resolveWorkId(id, state).displayId;
}
