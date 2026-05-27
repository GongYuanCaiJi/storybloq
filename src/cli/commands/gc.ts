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

    const errors: Array<{ id: string; error: string }> = [];

    await withProjectLock(root, { strict: false }, async ({ state }) => {
      const { guardPath } = await import("../../core/project-loader.js");
      plan = computeGcPlan(state, { retentionDays });
      const toRemove = options.force ? plan.candidates : plan.eligible;
      const wrapDir = resolve(root, ".story");

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
