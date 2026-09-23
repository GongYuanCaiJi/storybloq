/**
 * T-526: `storybloq brief` and `storybloq_context_brief` share one handler.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { BRIEF_BUDGET_MAX, BRIEF_BUDGET_MIN, handleBrief, handleBriefRebase, parseBriefBudget } from "../../../src/cli/commands/brief.js";
import { BRIEF_BUDGET_BYTES } from "../../../src/autonomous/context-brief.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { loadProject } from "../../../src/core/project-loader.js";
import type { CommandContext } from "../../../src/cli/types.js";
import type { OutputFormat } from "../../../src/models/types.js";
import { materialize } from "../../../scripts/continuity-lib.js";

const FIXTURE = resolve(__dirname, "../../fixtures/continuity");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-brief-"));
  materialize(FIXTURE, 1, "T-2.a", root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (args: string[]): void => { execFileSync("git", args, { cwd: root, env, stdio: "ignore" }); };
  g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  roots.push(root);
  return root;
}

async function ctx(root: string, format: OutputFormat): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

describe("storybloq brief", () => {
  it("md prints the rendered brief", async () => {
    const root = project();
    const out = (await handleBrief("T-2", {}, await ctx(root, "md"))).output;
    expect(out.startsWith("# Context brief: T-2")).toBe(true);
    expect(out).toContain("## Suggested accepted rulings");
  });

  it("json carries the tiers, the delivered record and the exact rendered text", async () => {
    const root = project();
    const env = JSON.parse((await handleBrief("T-2", {}, await ctx(root, "json"))).output) as { data: Record<string, unknown> };
    expect(env.data.suggested).toEqual(expect.arrayContaining([expect.objectContaining({ id: "r-p19bbvh0jhj8xgma" })]));
    expect(typeof env.data.rendered).toBe("string");
    expect(env.data.delivered).toMatchObject({ suggested: ["r-p19bbvh0jhj8xgma", "r-eftp2zdb6as643np"] });
    expect(env.data).not.toHaveProperty("manifest");
  });

  it("an unknown item is not_found; a budget outside its bounds is invalid_input", async () => {
    const root = project();
    await expect(handleBrief("T-99", {}, await ctx(root, "md"))).rejects.toMatchObject({ code: "not_found" });
    expect(parseBriefBudget(undefined)).toBe(BRIEF_BUDGET_BYTES);
    expect(parseBriefBudget(String(BRIEF_BUDGET_MIN))).toBe(BRIEF_BUDGET_MIN);
    for (const bad of [BRIEF_BUDGET_MIN - 1, BRIEF_BUDGET_MAX + 1, 1.5, "abc"]) {
      expect(() => parseBriefBudget(bad)).toThrow(CliValidationError);
    }
  });

  it("--rebase maps a refusal to invalid_input with its reason", async () => {
    const root = project();
    await expect(handleBriefRebase({ sessionId: "00000000-0000-0000-0000-000000000000", item: "T-2", reason: "", by: "cli" }, "md", root))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("--reason is required") });
    await expect(handleBriefRebase({ sessionId: "00000000-0000-0000-0000-000000000000", item: "T-2", reason: "why", by: "cli" }, "md", root))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("could not be read") });
  });
});
