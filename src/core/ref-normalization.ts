import type { ProjectState } from "./project-state.js";

export class RefResolutionError extends Error {
  constructor(
    public readonly reason: "missing" | "ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "RefResolutionError";
  }
}

export function resolveAndNormalizeTicketRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveTicketRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    throw new RefResolutionError("ambiguous", `Ref "${ref}" is ambiguous (matches: ${ids})`);
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeTicketRefs(
  state: ProjectState,
  refs: string[],
): string[] {
  if (refs.length === 0) return [];
  const resolved: string[] = [];
  for (const ref of refs) {
    resolved.push(resolveAndNormalizeTicketRef(state, ref));
  }
  return resolved;
}

export function resolveAndNormalizeIssueRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveIssueRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    throw new RefResolutionError("ambiguous", `Ref "${ref}" is ambiguous (matches: ${ids})`);
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeNoteRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveNoteRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    throw new RefResolutionError("ambiguous", `Ref "${ref}" is ambiguous (matches: ${ids})`);
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeLessonRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveLessonRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    throw new RefResolutionError("ambiguous", `Ref "${ref}" is ambiguous (matches: ${ids})`);
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}
