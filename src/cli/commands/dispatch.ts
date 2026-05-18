import { recommend } from "../../core/recommend.js";
import { buildDispatchPlan, type DispatchPlan } from "../../core/dispatch-plan.js";
import { detectClaudeVersion, spawnBackgroundAgent } from "../../autonomous/agent-view.js";
import type { CommandContext, CommandResult } from "../types.js";
import { ExitCode } from "../../core/output-formatter.js";
import type { Config } from "../../models/config.js";

export interface DispatchOptions {
  readonly ids: readonly string[] | "all";
  readonly count: number;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

function getMaxAgents(config: Config): number {
  return config.recipeOverrides?.maxParallelAgents ?? 3;
}

function formatPlan(plan: DispatchPlan): string {
  const lines: string[] = [];
  const versionStatus = plan.claudeVersionOk
    ? `available (v${plan.claudeVersion})`
    : plan.claudeVersion
      ? `too old (v${plan.claudeVersion}, need >= 2.1.139)`
      : "not found";

  lines.push("# Dispatch Plan");
  lines.push("");
  lines.push(`**Mode:** ${plan.mode} | **Agents:** ${plan.entries.length} | **Agent View:** ${versionStatus}`);
  lines.push("");

  if (plan.entries.length === 0) {
    lines.push("No dispatchable items found.");
  } else {
    lines.push("| # | ID | Kind | Title |");
    lines.push("|---|------|------|-------|");
    plan.entries.forEach((entry, i) => {
      const title = entry.target.title || "(explicit)";
      lines.push(`| ${i + 1} | ${entry.target.id} | ${entry.target.kind} | ${title} |`);
    });
  }

  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push(`**Skipped:** ${plan.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`);
  }

  return lines.join("\n");
}

function formatPlanJson(plan: DispatchPlan): string {
  return JSON.stringify(plan, null, 2);
}

function titleLookup(ctx: CommandContext): (id: string) => string | undefined {
  return (id) => {
    if (id.startsWith("ISS-")) return ctx.state.issueByID(id)?.title;
    return ctx.state.ticketByID(id)?.title;
  };
}

export function handleDispatchRecommend(ctx: CommandContext, count: number): CommandResult {
  const { recommendations } = recommend(ctx.state, count);
  const claudeVersion = detectClaudeVersion();
  const plan = buildDispatchPlan(recommendations, "all", ctx.root, claudeVersion, getMaxAgents(ctx.state.config as Config));

  const output = ctx.format === "json" ? formatPlanJson(plan) : formatPlan(plan);
  return { output };
}

export async function handleDispatch(ctx: CommandContext, options: DispatchOptions): Promise<CommandResult> {
  const { recommendations } = recommend(ctx.state, options.count);
  const claudeVersion = detectClaudeVersion();
  const plan = buildDispatchPlan(recommendations, options.ids, ctx.root, claudeVersion, getMaxAgents(ctx.state.config as Config), titleLookup(ctx));

  if (options.dryRun) {
    const output = ctx.format === "json" ? formatPlanJson(plan) : formatPlan(plan);
    return { output };
  }

  if (!plan.claudeVersionOk) {
    const reason = plan.claudeVersion
      ? `Claude Code v${plan.claudeVersion} is too old. Agent View requires >= 2.1.139.`
      : "Claude Code CLI not found in PATH.";
    return {
      output: `Error: ${reason}\nInstall or update: https://docs.anthropic.com/en/docs/claude-code`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  if (plan.entries.length === 0) {
    return { output: "No dispatchable items found. Run `storybloq recommend` to see available work." };
  }

  if (!options.yes) {
    const output = formatPlan(plan) + "\n\nRun with `--yes` to execute.";
    return { output };
  }

  const results: { id: string; success: boolean; error?: string }[] = [];
  for (const entry of plan.entries) {
    const name = `${entry.target.id}: ${entry.target.title}`.slice(0, 60);
    const result = spawnBackgroundAgent({
      cwd: entry.cwd,
      ids: [entry.target.id],
      name,
    });
    results.push({ id: entry.target.id, ...result });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];
  lines.push(`Dispatched ${succeeded}/${results.length} agents.`);
  if (failed.length > 0) {
    lines.push("");
    lines.push("**Failed:**");
    for (const f of failed) {
      lines.push(`- ${f.id}: ${f.error}`);
    }
  }
  lines.push("");
  lines.push("Monitor with: `claude agents`");

  const exitCode = failed.length > 0 ? ExitCode.PARTIAL : ExitCode.OK;
  return { output: lines.join("\n"), exitCode };
}
