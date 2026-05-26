import { computeReconcilePlan } from "../../core/reconcile.js";
import { formatReconcileResult, ExitCode } from "../../core/output-formatter.js";
import { withProjectLock } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";

export interface ReconcileOptions {
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly format: "md" | "json";
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

    output = formatReconcileResult(result, options.format);
    exitCode = ExitCode.OK;
  });

  return { output, exitCode };
}
