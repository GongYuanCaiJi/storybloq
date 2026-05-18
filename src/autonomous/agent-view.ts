import { execFileSync, spawn } from "node:child_process";

const CLAUDE_TIMEOUT = 5_000;

export function detectClaudeVersion(): string | null {
  try {
    const out = execFileSync("claude", ["--version"], {
      timeout: CLAUDE_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export interface SpawnOptions {
  cwd: string;
  ids: readonly string[];
  name?: string;
  model?: string;
}

export function spawnBackgroundAgent(opts: SpawnOptions): { success: boolean; error?: string } {
  const prompt = `/story auto ${opts.ids.join(" ")}`;
  const args = ["--bg"];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.name) {
    args.push("--name", opts.name);
  }
  args.push(prompt);

  try {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
