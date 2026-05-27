import { existsSync } from "node:fs";
import { join } from "node:path";
import { teamSetup } from "./team-setup.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";

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

  let schemaUpgraded = false;
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, team: { ...(state.config.team ?? {}) } };

    const prevSchema = typeof config.schemaVersion === "number" ? config.schemaVersion : 1;
    schemaUpgraded = prevSchema < 2;
    if (schemaUpgraded) {
      config.schemaVersion = 2;
    }

    config.team.enabled = true;

    if (config.team.claimStalenessHours === undefined) {
      config.team.claimStalenessHours = opts.claimStalenessHours ?? 48;
    }
    if (config.team.idAllocator === undefined) {
      config.team.idAllocator = opts.idAllocator ?? "local";
    }
    if (config.team.requiredFeatures === undefined) {
      config.team.requiredFeatures = ["merge-driver"];
    }
    if (config.team.minCliVersion === undefined) {
      try {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const pkg = require("../../package.json") as { version: string };
        config.team.minCliVersion = pkg.version;
      } catch {
        // Non-critical: version gate is best-effort
      }
    }

    await writeConfigUnlocked(config, root);
  });

  return {
    schemaVersionSet: schemaUpgraded,
    teamConfigured: true,
    mergeDriverInstalled: setupResult.driverInstalled,
    gitattributesWritten: setupResult.gitattributesWritten,
  };
}
