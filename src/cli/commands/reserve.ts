import { resolve } from "node:path";
import type { CommandResult } from "../types.js";

export async function handleReserve(
  root: string,
  type: "tickets" | "issues" | "notes" | "lessons",
  count: number,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { reserveDisplayId } = await import("../../core/remote-refs.js");

  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    return { output: "Error: --count must be an integer between 1 and 100.", exitCode: 1 };
  }

  const entityType = type.replace(/s$/, "") as "ticket" | "issue" | "note" | "lesson";
  const { state } = await loadProject(resolve(root));

  if (state.config.team?.idAllocator !== "git-refs") {
    return {
      output: format === "json"
        ? JSON.stringify({ ok: false, error: "team.idAllocator must be \"git-refs\" to reserve IDs." }, null, 2)
        : "Error: team.idAllocator must be \"git-refs\" to reserve IDs. Set it in .story/config.json.",
      exitCode: 1,
    };
  }

  const reserved: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const result = await reserveDisplayId(root, entityType, state);
      reserved.push(result.displayId);
    } catch (err) {
      failed.push(err instanceof Error ? err.message : String(err));
      break;
    }
  }

  const hasFailures = failed.length > 0;

  if (format === "json") {
    return {
      output: JSON.stringify({ ok: !hasFailures, data: { reserved, failed } }, null, 2),
      exitCode: hasFailures ? 1 : undefined,
    };
  }

  const lines: string[] = [];
  if (reserved.length > 0) {
    lines.push(`Reserved ${reserved.length} ${type}:`);
    for (const id of reserved) lines.push(`  - ${id}`);
  }
  if (failed.length > 0) {
    lines.push(`Failed: ${failed[0]}`);
  }
  if (reserved.length === 0 && failed.length === 0) {
    lines.push("Nothing to reserve.");
  }

  return { output: lines.join("\n"), exitCode: hasFailures ? 1 : undefined };
}
