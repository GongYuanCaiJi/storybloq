import { resolve } from "node:path";
import { hasConflicts } from "../../core/conflicts.js";
import { resolveConflicts, type ResolveOptions } from "../../core/resolve.js";
import type { CommandResult } from "../types.js";

export async function handleConflictsList(
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(resolve(root));
  const report = hasConflicts(state);

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: report }, null, 2) };
  }

  if (!report.hasConflicts) {
    return { output: "No conflicts found." };
  }

  const lines = ["## Conflicts", "", "| Type | ID | Fields |", "|------|----|--------|"];
  for (const item of report.items) {
    lines.push(`| ${item.type} | ${item.id} | ${item.conflictCount} |`);
  }
  lines.push("", "Run `storybloq conflicts show <id>` for details, then `storybloq resolve <id>` to fix.");
  return { output: lines.join("\n") };
}

export async function handleConflictsShow(
  id: string,
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(resolve(root));

  const entity = state.ticketByID(id) ?? state.issueByID(id) ?? state.noteByID(id) ?? state.lessonByID(id);
  if (!entity) {
    return { output: `Entity ${id} not found.`, exitCode: 1 };
  }

  const conflicts = (entity as Record<string, unknown>)._conflicts as Array<Record<string, unknown>> | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { output: `${id} has no conflicts.` };
  }

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: { id, conflicts } }, null, 2) };
  }

  const lines = [`## Conflicts for ${id}`, ""];
  for (const c of conflicts) {
    const group = c.group ? ` (group: ${c.group})` : "";
    lines.push(`### ${c.fieldPath} [${c.kind}]${group}`);
    lines.push(`- Base:   ${JSON.stringify(c.base)}`);
    lines.push(`- Ours:   ${JSON.stringify(c.ours)}`);
    lines.push(`- Theirs: ${JSON.stringify(c.theirs)}`);
    lines.push("");
  }
  return { output: lines.join("\n") };
}

export async function handleResolve(
  id: string,
  root: string,
  options: ResolveOptions & { format?: "md" | "json" },
): Promise<CommandResult> {
  const format = options.format ?? "md";
  const { withConflictResolutionLock, writeTicketUnlocked, writeIssueUnlocked, writeNoteUnlocked, writeLessonUnlocked } = await import("../../core/project-loader.js");

  let output = "";

  await withConflictResolutionLock(root, async ({ state }) => {
    const ticket = state.ticketByID(id);
    const issue = !ticket ? state.issueByID(id) : undefined;
    const note = !ticket && !issue ? state.noteByID(id) : undefined;
    const lesson = !ticket && !issue && !note ? state.lessonByID(id) : undefined;
    const entity = ticket ?? issue ?? note ?? lesson;

    if (!entity) {
      output = format === "json"
        ? JSON.stringify({ ok: false, error: `Entity ${id} not found.` }, null, 2)
        : `Entity ${id} not found.`;
      return;
    }

    const mutable = { ...entity } as Record<string, unknown>;
    const result = resolveConflicts(mutable, options);

    if (ticket) await writeTicketUnlocked(mutable as any, root);
    else if (issue) await writeIssueUnlocked(mutable as any, root);
    else if (note) await writeNoteUnlocked(mutable as any, root);
    else if (lesson) await writeLessonUnlocked(mutable as any, root);

    if (format === "json") {
      output = JSON.stringify({ ok: true, data: result }, null, 2);
    } else {
      const lines = [`Resolved ${result.resolved.length} conflict(s) on ${id}.`];
      if (result.remaining > 0) {
        lines.push(`${result.remaining} conflict(s) remaining.`);
      } else {
        lines.push("All conflicts resolved.");
      }
      output = lines.join("\n");
    }
  });

  return { output };
}
