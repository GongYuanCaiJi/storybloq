import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleMigrate } from "../../../src/cli/commands/migrate.js";

async function setupProject(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });
  await writeFile(join(storyDir, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }, null, 2));
  return dir;
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, ".story", "config.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("storybloq migrate", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("reports already migrated when schemaVersion >= 2", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 2, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    });
    tmpDirs.push(dir);
    const result = await handleMigrate(dir, "md", { dryRun: false });
    expect(result.output).toContain("Already");
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(2);
  });

  it("bumps schemaVersion for non-orchestrator config", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    });
    tmpDirs.push(dir);
    const result = await handleMigrate(dir, "md", { dryRun: false });
    expect(result.errorCode).toBeUndefined();
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(2);
  });

  it("fills missing node defaults for orchestrator config", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "studio", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: {
        engine: { path: "~/Developer/engine" },
      },
    });
    tmpDirs.push(dir);
    await handleMigrate(dir, "md", { dryRun: false });
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(2);
    const nodes = config.nodes as Record<string, Record<string, unknown>>;
    expect(nodes.engine.health).toBe("grey");
    expect(nodes.engine.dependsOn).toEqual([]);
    expect(nodes.engine.stack).toBe("");
    expect(nodes.engine.role).toBe("");
    expect(nodes.engine.summary).toBe("");
  });

  it("preserves existing node values during migration (partial migration)", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "studio", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: {
        engine: {
          path: "~/Developer/engine",
          health: "red",
          role: "Core engine",
          stack: "swift-spm",
          summary: "Needs attention",
          dependsOn: [],
        },
      },
    });
    tmpDirs.push(dir);
    await handleMigrate(dir, "md", { dryRun: false });
    const config = await readConfig(dir);
    const nodes = config.nodes as Record<string, Record<string, unknown>>;
    expect(nodes.engine.health).toBe("red");
    expect(nodes.engine.role).toBe("Core engine");
    expect(nodes.engine.stack).toBe("swift-spm");
    expect(nodes.engine.summary).toBe("Needs attention");
  });

  it("aborts on invalid node name", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "studio", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: {
        "My-Engine": { path: "~/Developer/engine" },
      },
    });
    tmpDirs.push(dir);
    const result = await handleMigrate(dir, "md", { dryRun: false });
    expect(result.errorCode).toBeDefined();
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(1);
  });

  it("aborts on dependsOn cycle", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "studio", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: {
        a: { path: "~/Dev/a", dependsOn: ["b"] },
        b: { path: "~/Dev/b", dependsOn: ["a"] },
      },
    });
    tmpDirs.push(dir);
    const result = await handleMigrate(dir, "md", { dryRun: false });
    expect(result.errorCode).toBeDefined();
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(1);
  });

  it("dry-run shows changes without writing", async () => {
    const dir = await setupProject({
      version: 2, schemaVersion: 1, project: "studio", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: {
        engine: { path: "~/Developer/engine" },
      },
    });
    tmpDirs.push(dir);
    const result = await handleMigrate(dir, "md", { dryRun: true });
    expect(result.errorCode).toBeUndefined();
    const config = await readConfig(dir);
    expect(config.schemaVersion).toBe(1);
  });

  it("handles malformed JSON gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
    tmpDirs.push(dir);
    const storyDir = join(dir, ".story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "config.json"), "{ invalid json }");
    const result = await handleMigrate(dir, "md", { dryRun: false });
    expect(result.errorCode).toBeDefined();
  });
});
