import { resolve } from "node:path";
import { hasConflicts } from "../../core/conflicts.js";
import { resolveConflicts, isEntityLevel, type ResolveOptions, type ResolveResult } from "../../core/resolve.js";
import { resolveDocConflicts } from "../../core/resolve-doc.js";
import { displayIdOf } from "../../core/resolver.js";
import type { ProjectState } from "../../core/project-state.js";
import type { LoadWarning } from "../../core/errors.js";
import type { ConflictEntry } from "../../models/types.js";
import type { CommandResult } from "../types.js";

export type ConflictTarget =
  | { kind: "config" }
  | { kind: "roadmap" }
  | { kind: "ticket" | "issue" | "note" | "lesson"; entity: Record<string, unknown> }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "missing" };

/**
 * Unified conflict-target lookup: config/roadmap by name (both the report ids
 * "config.json"/"roadmap.json" and the short aliases), entities through the
 * display-ID-aware resolvers like every other command.
 */
export function resolveConflictTarget(state: ProjectState, id: string): ConflictTarget {
  if (id === "config" || id === "config.json") return { kind: "config" };
  if (id === "roadmap" || id === "roadmap.json") return { kind: "roadmap" };

  const chains = [
    { kind: "ticket" as const, result: state.resolveTicketRef(id) },
    { kind: "issue" as const, result: state.resolveIssueRef(id) },
    { kind: "note" as const, result: state.resolveNoteRef(id) },
    { kind: "lesson" as const, result: state.resolveLessonRef(id) },
  ];
  for (const { kind, result } of chains) {
    if (result.kind === "found") return { kind, entity: result.item as Record<string, unknown> };
  }
  for (const { result } of chains) {
    if (result.kind === "ambiguous") {
      return { kind: "ambiguous", matches: result.matches.map((m) => (m as { id: string }).id) };
    }
  }
  return { kind: "missing" };
}

const DAMAGE_WARNING_TYPES = new Set(["schema_error", "parse_error"]);

function diagnosticsSection(warnings: readonly LoadWarning[]): string[] {
  const damaged = warnings.filter((w) => DAMAGE_WARNING_TYPES.has(w.type));
  if (damaged.length === 0) return [];
  const paths = damaged.map((w) => w.file);
  return [
    "",
    `${damaged.length} file(s) failed to load and may contain merge damage: ${paths.join(", ")}. ` +
    `Restore with git (e.g. git checkout --theirs -- ${paths[0]}) or hand-edit, then rerun.`,
  ];
}

export async function handleConflictsList(
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { state, warnings } = await loadProject(resolve(root));
  const report = hasConflicts(state);

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: report }, null, 2) };
  }

  if (!report.hasConflicts) {
    return { output: ["No conflicts found.", ...diagnosticsSection(warnings)].join("\n") };
  }

  const lines = ["## Conflicts", "", "| Type | ID | Fields |", "|------|----|--------|"];
  for (const item of report.items) {
    let shownId = item.id;
    if (item.type === "ticket" || item.type === "issue" || item.type === "note" || item.type === "lesson") {
      const target = resolveConflictTarget(state, item.id);
      if ("entity" in target) shownId = displayIdOf(target.entity as { id: string; displayId?: string | null });
    }
    lines.push(`| ${item.type} | ${shownId} | ${item.conflictCount} |`);
  }
  lines.push(
    "",
    "Run `storybloq conflicts show <id>`, then `storybloq resolve <id> --use ours|theirs`. " +
    "For config.json/roadmap.json use `storybloq resolve config` / `storybloq resolve roadmap`.",
  );
  lines.push(...diagnosticsSection(warnings));
  return { output: lines.join("\n") };
}

function isDeletedSnapshot(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || obj.deletedAt != null;
}

function sideSummary(label: string, value: unknown): string {
  if (typeof value === "string") {
    return `- ${label}: "${value}" (snapshots unavailable, pre-1.5.0)`;
  }
  if (value === null || value === undefined) {
    return `- ${label}: (absent)`;
  }
  const snap = value as Record<string, unknown>;
  if (isDeletedSnapshot(snap)) {
    return `- ${label}: deleted (tombstone by ${String(snap.deletedBy ?? "unknown")} at ${String(snap.deletedAt ?? "unknown")})`;
  }
  return `- ${label}: edited (title: ${JSON.stringify(snap.title ?? snap.name ?? snap.id ?? "?")})`;
}

function renderConflicts(displayId: string, conflicts: Array<Record<string, unknown>>): string {
  const lines = [`## Conflicts for ${displayId}`, ""];
  for (const c of conflicts) {
    if (isEntityLevel(c as ConflictEntry)) {
      lines.push(`### (entire entity) [${String(c.kind)}]`);
      lines.push(sideSummary("Base", c.base));
      lines.push(sideSummary("Ours", c.ours));
      lines.push(sideSummary("Theirs", c.theirs));
      lines.push(`Resolve with: storybloq resolve ${displayId} --use ours|theirs (whole entity)`);
      lines.push("");
      continue;
    }
    const group = c.group ? ` (group: ${c.group})` : "";
    lines.push(`### ${c.fieldPath} [${c.kind}]${group}`);
    lines.push(`- Base:   ${JSON.stringify(c.base)}`);
    lines.push(`- Ours:   ${JSON.stringify(c.ours)}`);
    lines.push(`- Theirs: ${JSON.stringify(c.theirs)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function handleConflictsShow(
  id: string,
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(resolve(root));

  const target = resolveConflictTarget(state, id);
  if (target.kind === "missing") {
    return { output: `Entity ${id} not found.`, exitCode: 1 };
  }
  if (target.kind === "ambiguous") {
    return { output: `Ref "${id}" is ambiguous (matches: ${target.matches.join(", ")})`, exitCode: 1 };
  }

  let holder: Record<string, unknown>;
  let label: string;
  if (target.kind === "config") {
    holder = state.config as Record<string, unknown>;
    label = "config.json";
  } else if (target.kind === "roadmap") {
    holder = state.roadmap as Record<string, unknown>;
    label = "roadmap.json";
  } else {
    holder = target.entity;
    label = displayIdOf(target.entity as { id: string; displayId?: string | null });
  }

  const conflicts = holder._conflicts as Array<Record<string, unknown>> | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { output: `${label} has no conflicts.` };
  }

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: { id: label, conflicts } }, null, 2) };
  }

  return { output: renderConflicts(label, conflicts) };
}

export async function handleResolve(
  id: string,
  root: string,
  options: ResolveOptions & { format?: "md" | "json" },
): Promise<CommandResult> {
  const format = options.format ?? "md";
  const {
    withConflictResolutionLock,
    writeTicketUnlocked, writeIssueUnlocked, writeNoteUnlocked, writeLessonUnlocked,
    writeConfigUnlocked, writeRoadmapUnlocked,
    resolveActor,
  } = await import("../../core/project-loader.js");

  const actor = await resolveActor(root, options.actor);

  let output = "";
  let exitCode: 0 | 1 = 0;

  await withConflictResolutionLock(root, async ({ state }) => {
    const target = resolveConflictTarget(state, id);

    if (target.kind === "missing") {
      output = format === "json"
        ? JSON.stringify({ ok: false, error: `Entity ${id} not found.` }, null, 2)
        : `Entity ${id} not found.`;
      exitCode = 1;
      return;
    }
    if (target.kind === "ambiguous") {
      const message = `Ref "${id}" is ambiguous (matches: ${target.matches.join(", ")})`;
      output = format === "json"
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : message;
      exitCode = 1;
      return;
    }

    const resolveOptions: ResolveOptions = { ...options, actor };
    let result: ResolveResult;
    let label: string;

    if (target.kind === "config") {
      const mutable = { ...(state.config as Record<string, unknown>) };
      result = resolveDocConflicts(mutable, resolveOptions);
      try {
        await writeConfigUnlocked(mutable as never, root);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The chosen side leaves config.json invalid; pick the other side or supply --value.`,
        );
      }
      label = "config.json";
    } else if (target.kind === "roadmap") {
      const mutable = { ...(state.roadmap as Record<string, unknown>) };
      result = resolveDocConflicts(mutable, resolveOptions);
      try {
        await writeRoadmapUnlocked(mutable as never, root);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The chosen side leaves roadmap.json invalid; pick the other side or supply --value.`,
        );
      }
      label = "roadmap.json";
    } else {
      const mutable = { ...target.entity };
      result = resolveConflicts(mutable, resolveOptions);
      if (target.kind === "ticket") await writeTicketUnlocked(mutable as never, root);
      else if (target.kind === "issue") await writeIssueUnlocked(mutable as never, root);
      else if (target.kind === "note") await writeNoteUnlocked(mutable as never, root);
      else await writeLessonUnlocked(mutable as never, root);
      label = displayIdOf(target.entity as { id: string; displayId?: string | null });
    }

    if (format === "json") {
      output = JSON.stringify({ ok: true, data: result }, null, 2);
    } else {
      const lines = [`Resolved ${result.resolved.length} conflict(s) on ${label}.`];
      lines.push(...result.messages);
      lines.push(...result.warnings);
      if (result.remaining > 0) {
        lines.push(`${result.remaining} conflict(s) remaining.`);
      } else {
        lines.push("All conflicts resolved.");
      }
      output = lines.join("\n");
    }
  });

  return exitCode === 0 ? { output } : { output, exitCode };
}
