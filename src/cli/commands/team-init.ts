import { teamInit, type TeamInitOptions } from "../../core/team-init.js";

export interface TeamInitOutput {
  output: string;
  exitCode: number;
}

const ROLLOUT_WARNING = `
Team mode enabled. Before merging to main:
  1. All teammates must update their CLI: npm i -g @storybloq/storybloq@latest
  2. Each teammate runs: storybloq team setup
  3. Clients released before schema gate cannot be forced to fail fast
`.trim();

export async function handleTeamInit(
  root: string,
  opts: TeamInitOptions & { format?: "md" | "json" },
): Promise<TeamInitOutput> {
  try {
    const result = await teamInit(root, opts);

    if (opts.format === "json") {
      return { output: JSON.stringify({ ...result, warning: ROLLOUT_WARNING }), exitCode: 0 };
    }

    const lines: string[] = [
      "Team init complete:",
      `  Schema version: ${result.schemaVersionSet ? "set to 2" : "already 2+"}`,
      `  Team config: ${result.teamConfigured ? "configured" : "skipped"}`,
      `  Merge driver: ${result.mergeDriverInstalled ? "installed" : "skipped"}`,
      `  .gitattributes: ${result.gitattributesWritten ? "written" : "skipped"}`,
      "",
      ROLLOUT_WARNING,
      "",
      "To commit these changes:",
      '  git add .story/config.json .story/.gitattributes && git commit -m "chore: enable team mode"',
    ];
    return { output: lines.join("\n"), exitCode: 0 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.format === "json") {
      return { output: JSON.stringify({ error: message }), exitCode: 1 };
    }
    return { output: `Error: ${message}`, exitCode: 1 };
  }
}
