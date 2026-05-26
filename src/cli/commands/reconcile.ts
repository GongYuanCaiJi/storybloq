import { computeReconcilePlan, type ReconcileRename } from "../../core/reconcile.js";
import { formatReconcileResult, ExitCode } from "../../core/output-formatter.js";
import { withProjectLock, atomicWrite } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReconcileOptions {
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly format: "md" | "json";
}

const ENTITY_DIRS: Record<string, string> = {
  ticket: "tickets",
  issue: "issues",
  note: "notes",
  lesson: "lessons",
};

async function applyRenames(root: string, renames: ReconcileRename[]): Promise<void> {
  const storyDir = join(root, ".story");
  for (const rename of renames) {
    const dir = ENTITY_DIRS[rename.entityType];
    if (!dir) continue;
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(storyDir, dir)));
    const match = files.find((f) => f.endsWith(".json") && f.replace(/\.json$/, "") === rename.id);
    if (!match) continue;
    const filePath = join(storyDir, dir, match);
    const raw = await readFile(filePath, "utf-8");
    const entity = JSON.parse(raw) as Record<string, unknown>;
    const oldDisplayId = (entity.displayId as string | undefined) ?? entity.id as string;
    entity.displayId = rename.newDisplayId;
    const prev = Array.isArray(entity.previousDisplayIds) ? [...entity.previousDisplayIds] : [];
    if (!prev.includes(oldDisplayId)) prev.push(oldDisplayId);
    entity.previousDisplayIds = prev;
    await atomicWrite(filePath, JSON.stringify(entity, null, 2) + "\n");
  }
}

export async function handleReconcile(
  root: string,
  options: ReconcileOptions,
): Promise<CommandResult> {
  let output = "";
  let exitCode: number = ExitCode.OK;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const result = computeReconcilePlan(state);

    if (!result.ok) {
      output = formatReconcileResult(result, options.format);
      exitCode = ExitCode.ERROR;
      return;
    }

    if (options.ci) {
      if (result.plan.renames.length > 0) {
        output = formatReconcileResult(result, options.format);
        exitCode = 1;
      } else {
        output = "No duplicate displayIds found. Project is clean.";
        exitCode = ExitCode.OK;
      }
      return;
    }

    if (options.dryRun || result.plan.renames.length === 0) {
      output = formatReconcileResult(result, options.format);
      exitCode = ExitCode.OK;
      return;
    }

    await applyRenames(root, result.plan.renames);
    output = formatReconcileResult(result, options.format);
    exitCode = ExitCode.OK;
  });

  return { output, exitCode };
}
