import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { resolveNodePath } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

async function createOrchestratorWithNode(
  nodeName: string,
  nodeDir: string,
  extraConfig?: Record<string, unknown>,
): Promise<string> {
  const orchDir = await mkdtemp(join(tmpdir(), "orch-init-"));
  tmpDirs.push(orchDir);
  const storyDir = join(orchDir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  const config = {
    version: 2,
    schemaVersion: 2,
    project: "test-orch",
    type: "orchestrator",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    nodes: {
      [nodeName]: { path: nodeDir, stack: "swift-spm", role: "test node", health: "grey", dependsOn: [] },
    },
    ...extraConfig,
  };
  await writeFile(join(storyDir, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));
  return orchDir;
}

async function createEmptyNodeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "node-init-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("node init (integration)", () => {
  it("inits .story/ in an empty node directory", async () => {
    const nodeDir = await createEmptyNodeDir();
    const result = await initProject(nodeDir, { name: "engine" });
    expect(result.created.some((f) => f.includes("config.json"))).toBe(true);
    expect(existsSync(join(nodeDir, ".story", "config.json"))).toBe(true);
    expect(existsSync(join(nodeDir, ".story", "tickets"))).toBe(true);
  });

  it("sets correct project name from node name", async () => {
    const nodeDir = await createEmptyNodeDir();
    await initProject(nodeDir, { name: "my-engine", type: "swift-spm" });
    const raw = await readFile(join(nodeDir, ".story", "config.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.project).toBe("my-engine");
    expect(config.type).toBe("swift-spm");
  });

  it("passes type and language to init", async () => {
    const nodeDir = await createEmptyNodeDir();
    await initProject(nodeDir, { name: "cloud", type: "npm", language: "typescript" });
    const raw = await readFile(join(nodeDir, ".story", "config.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.type).toBe("npm");
    expect(config.language).toBe("typescript");
  });

  it("rejects if .story/ exists without force", async () => {
    const nodeDir = await createEmptyNodeDir();
    await initProject(nodeDir, { name: "engine" });
    await expect(initProject(nodeDir, { name: "engine" })).rejects.toThrow();
  });

  it("force overwrites existing .story/", async () => {
    const nodeDir = await createEmptyNodeDir();
    await initProject(nodeDir, { name: "old-name" });
    const result = await initProject(nodeDir, { name: "new-name", force: true });
    expect(result.created.some((f) => f.includes("config.json"))).toBe(true);
    const raw = await readFile(join(nodeDir, ".story", "config.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.project).toBe("new-name");
  });

  it("resolveNodePath returns 'no .story/config.json found' for empty node", async () => {
    const nodeDir = await createEmptyNodeDir();
    const orchDir = await createOrchestratorWithNode("engine", nodeDir);
    const resolved = resolveNodePath(nodeDir, orchDir);
    expect(resolved.resolved).toBe(false);
    if (!resolved.resolved) {
      expect(resolved.reason).toBe("no .story/config.json found");
    }
  });

  it("resolveNodePath succeeds after init", async () => {
    const nodeDir = await createEmptyNodeDir();
    const orchDir = await createOrchestratorWithNode("engine", nodeDir);
    await initProject(nodeDir, { name: "engine" });
    const resolved = resolveNodePath(nodeDir, orchDir);
    expect(resolved.resolved).toBe(true);
  });

  it("orchestrator can read inited node's config via resolveNodePath", async () => {
    const nodeDir = await createEmptyNodeDir();
    const orchDir = await createOrchestratorWithNode("engine", nodeDir);
    await initProject(nodeDir, { name: "engine", type: "swift-spm", language: "swift" });
    const resolved = resolveNodePath(nodeDir, orchDir);
    expect(resolved.resolved).toBe(true);
    if (resolved.resolved) {
      const raw = await readFile(join(resolved.storyDir, "config.json"), "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      expect(config.project).toBe("engine");
    }
  });

  it("does not require allowNodeWrites for init", async () => {
    const nodeDir = await createEmptyNodeDir();
    const orchDir = await createOrchestratorWithNode("engine", nodeDir, {
      federation: { allowNodeWrites: false },
    });
    const result = await initProject(nodeDir, { name: "engine" });
    expect(result.created.some((f) => f.includes("config.json"))).toBe(true);
    expect(existsSync(join(nodeDir, ".story", "config.json"))).toBe(true);
    void orchDir;
  });
});
