import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { teamInit } from "../../src/core/team-init.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-init-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  for (const dir of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(storyDir, dir), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
      blockers: [],
    }, null, 2) + "\n",
    "utf-8",
  );
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    project: "test",
    type: "npm",
    language: "ts",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
    ...overrides,
  };
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
}

describe("T-366: team-init", () => {
  it("sets schemaVersion to 2", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const config = readConfig(root);
    expect(config.schemaVersion).toBe(2);
  });

  it("sets team defaults", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team).toBeDefined();
    expect(team.claimStalenessHours).toBe(48);
    expect(team.idAllocator).toBe("local");
  });

  it("preserves existing config fields", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({
      customField: "preserved",
      recipe: "coding",
    }));
    await teamInit(root, {});
    const config = readConfig(root);
    expect(config.customField).toBe("preserved");
    expect(config.recipe).toBe("coding");
    expect(config.project).toBe("test");
  });

  it("preserves existing team fields", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({
      team: { minCliVersion: "2.0.0", idAllocator: "git-refs" },
    }));
    await teamInit(root, {});
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team.minCliVersion).toBe("2.0.0");
    expect(team.idAllocator).toBe("git-refs");
  });

  it("installs merge driver", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const driver = execFileSync("git", ["config", "--local", "--get", "merge.storybloq-json.driver"], { cwd: root, encoding: "utf-8" }).trim();
    expect(driver).toBe("storybloq merge-driver %O %A %B %P");
  });

  it("writes gitattributes", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const attrs = readFileSync(join(root, ".story", ".gitattributes"), "utf-8");
    expect(attrs).toContain("tickets/*.json merge=storybloq-json");
  });

  it("writes the running CLI version as minCliVersion (ISS-748)", async () => {
    vi.stubEnv("STORYBLOQ_VERSION", "7.7.7");
    try {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamInit(root, {});
      const team = readConfig(root).team as Record<string, unknown>;
      // ISS-748: the broken relative require read the workspace-root manifest and
      // wrote its version; the value must come from the CLI's own version instead.
      expect(team.minCliVersion).toBe("7.7.7");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails if no .story/ dir", async () => {
    const root = createTempGitRepo();
    await expect(teamInit(root, {})).rejects.toThrow();
  });

  it("idempotent: second run preserves state", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const first = readConfig(root);
    await teamInit(root, {});
    const second = readConfig(root);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    expect((second.team as Record<string, unknown>).claimStalenessHours)
      .toBe((first.team as Record<string, unknown>).claimStalenessHours);
  });

  it("accepts custom options", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, { claimStalenessHours: 24, idAllocator: "git-refs" });
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team.claimStalenessHours).toBe(24);
    expect(team.idAllocator).toBe("git-refs");
  });
});
