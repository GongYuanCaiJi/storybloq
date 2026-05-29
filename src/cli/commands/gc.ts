import { resolve, join } from "node:path";
import { unlink } from "node:fs/promises";
import { computeGcPlan, type GcPlan } from "../../core/gc.js";
import type { CommandResult } from "../types.js";

export interface GcCliOptions {
  apply?: boolean;
  force?: boolean;
  retentionDays?: number;
  format?: "md" | "json";
}

export async function handleGc(
  root: string,
  options: GcCliOptions,
): Promise<CommandResult> {
  const format = options.format ?? "md";
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    return { output: "Error: --retention-days must be a non-negative integer.", exitCode: 1 };
  }

  if (options.apply) {
    const { withProjectLock } = await import("../../core/project-loader.js");
    let applied: string[] = [];
    let plan: GcPlan | undefined;
    let refusal: string | undefined;

    const errors: Array<{ id: string; error: string }> = [];

    await withProjectLock(root, { strict: false }, async ({ state }) => {
      const { guardPath } = await import("../../core/project-loader.js");
      plan = computeGcPlan(state, { retentionDays });

      // ISS-704: --force must NOT physically purge tombstones that active items
      // still reference. Cross-refs store canonical IDs and are never rewritten,
      // so unlinking a referenced tombstone leaves a dangling
      // blockedBy/parentTicket/relatedTickets/supersedes ref, escalating the
      // tolerated *_deleted WARNINGS into ERROR-level invalid_*_ref. Refuse
      // atomically (purge nothing) and direct the user to repair, which removes
      // the stale references first. Eligible (unreferenced) tombstones are still
      // purged by --force when nothing is blocked.
      if (options.force && plan.blocked.length > 0) {
        const lines = plan.blocked
          .map((c) => `  - ${c.id} (referenced by ${c.activeReferences.join(", ")})`)
          .join("\n");
        refusal = `Error: gc --force cannot purge ${plan.blocked.length} tombstone(s) still referenced by active items; physically removing them would dangle canonical references and fail validation:\n${lines}\n\nRun \`storybloq repair\` to remove the stale references first, then re-run gc.`;
        return;
      }

      const toRemove = options.force ? plan.candidates : plan.eligible;
      const wrapDir = resolve(root, ".story");

      // GC physically purges tombstones that have aged past retention (N-059 v6.5).
      // The delete path already wrote the tombstone with the real deletedAt/deletedBy and
      // propagated it to peers; GC's job is the final removal, identical in team and non-team mode.
      for (const c of toRemove) {
        const subdir = c.type === "ticket" ? "tickets" : c.type === "issue" ? "issues" : c.type === "note" ? "notes" : "lessons";
        const targetPath = join(wrapDir, subdir, `${c.id}.json`);
        try {
          await guardPath(targetPath, wrapDir);
          await unlink(targetPath);
          applied.push(c.id);
        } catch (err) {
          errors.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    if (refusal) {
      return { output: refusal, exitCode: 1 };
    }

    if (errors.length > 0) {
      const errLines = errors.map((e) => `  - ${e.id}: ${e.error}`).join("\n");
      const base = formatGcResult(plan!, applied, format);
      return { output: `${base}\n\n### Errors\n${errLines}`, exitCode: 1 };
    }

    return { output: formatGcResult(plan!, applied, format) };
  }

  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(resolve(root));
  const plan = computeGcPlan(state, { retentionDays });
  return { output: formatGcResult(plan, null, format) };
}

function formatGcResult(plan: GcPlan, applied: string[] | null, format: "md" | "json"): string {
  if (format === "json") {
    return JSON.stringify({
      ok: true,
      data: {
        retentionDays: plan.retentionDays,
        eligible: plan.eligible.map((c) => ({ type: c.type, id: c.id, age: c.age })),
        blocked: plan.blocked.map((c) => ({ type: c.type, id: c.id, age: c.age, activeReferences: c.activeReferences })),
        warnings: plan.warnings,
        applied: applied ?? [],
      },
    }, null, 2);
  }

  const lines: string[] = [];
  if (applied) {
    lines.push(`## GC Applied`);
    if (applied.length === 0) {
      lines.push("No items removed.");
    } else {
      lines.push(`Removed ${applied.length} item(s):`);
      for (const id of applied) lines.push(`  - ${id}`);
    }
  } else {
    lines.push(`## GC Dry Run (retention: ${plan.retentionDays} days)`);
  }

  if (plan.eligible.length > 0) {
    lines.push("");
    lines.push("### Eligible for removal");
    lines.push("| Type | ID | Age (days) |");
    lines.push("|------|----|------------|");
    for (const c of plan.eligible) {
      lines.push(`| ${c.type} | ${c.id} | ${c.age} |`);
    }
  }

  if (plan.blocked.length > 0) {
    lines.push("");
    lines.push("### Blocked (active references)");
    lines.push("| Type | ID | Age (days) | Referenced by |");
    lines.push("|------|----|------------|---------------|");
    for (const c of plan.blocked) {
      lines.push(`| ${c.type} | ${c.id} | ${c.age} | ${c.activeReferences.join(", ")} |`);
    }
    lines.push("");
    lines.push("Run `storybloq repair` to clean up references, or use `--force` to remove anyway.");
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("### Warnings");
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }

  if (plan.candidates.length === 0 && plan.warnings.length === 0 && !applied) {
    lines.push("No tombstoned items past retention period.");
  }

  return lines.join("\n");
}
