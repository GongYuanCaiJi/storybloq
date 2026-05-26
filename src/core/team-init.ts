import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { teamSetup } from "./team-setup.js";

export interface TeamInitOptions {
  claimStalenessHours?: number;
  idAllocator?: "local" | "git-refs";
}

export interface TeamInitResult {
  schemaVersionSet: boolean;
  teamConfigured: boolean;
  mergeDriverInstalled: boolean;
  gitattributesWritten: boolean;
}

export async function teamInit(root: string, opts: TeamInitOptions): Promise<TeamInitResult> {
  const storyDir = join(root, ".story");
  if (!existsSync(storyDir)) {
    throw new Error("No .story/ directory found");
  }

  const configPath = join(storyDir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error("No .story/config.json found");
  }

  const setupResult = await teamSetup(root);

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  const prevSchema = typeof config.schemaVersion === "number" ? config.schemaVersion : 1;
  if (prevSchema < 2) {
    config.schemaVersion = 2;
  }

  if (!config.team || typeof config.team !== "object" || Array.isArray(config.team)) {
    config.team = {};
  }
  const team = config.team as Record<string, unknown>;

  if (team.claimStalenessHours === undefined) {
    team.claimStalenessHours = opts.claimStalenessHours ?? 48;
  }
  if (team.idAllocator === undefined) {
    team.idAllocator = opts.idAllocator ?? "local";
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  return {
    schemaVersionSet: true,
    teamConfigured: true,
    mergeDriverInstalled: setupResult.driverInstalled,
    gitattributesWritten: setupResult.gitattributesWritten,
  };
}
