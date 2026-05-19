import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodePath, resolveAllNodes } from "../../src/federation/resolver.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

async function createNodeDir(name?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name ?? "fed-resolver-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(storyDir, { recursive: true });
  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: name ?? "test-node",
      type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("resolveNodePath", () => {
  it("resolves valid absolute path with .story/config.json", async () => {
    const nodeDir = await createNodeDir("engine");
    const orchestratorDir = await createNodeDir("orchestrator");
    const nodeDirReal = await realpath(nodeDir);
    const result = resolveNodePath(nodeDir, orchestratorDir);
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.absolutePath).toBe(nodeDirReal);
      expect(result.storyDir).toBe(join(nodeDirReal, ".story"));
    }
  });

  it("expands ~ path to homedir", async () => {
    const result = resolveNodePath("~/nonexistent-storybloq-test", "/tmp/orch");
    expect(result.resolved).toBe(false);
    expect(result.rawPath).toBe("~/nonexistent-storybloq-test");
  });

  it("returns resolved: false for non-existent path", () => {
    const result = resolveNodePath("/tmp/nonexistent-xyz-" + Date.now(), "/tmp/orch");
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBeTruthy();
    }
  });

  it("returns resolved: false for path without .story/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-no-story-"));
    tmpDirs.push(dir);
    const orchDir = await createNodeDir("orchestrator");
    const result = resolveNodePath(dir, orchDir);
    expect(result.resolved).toBe(false);
  });

  it("returns resolved: false for self-reference", async () => {
    const orchDir = await createNodeDir("orchestrator");
    const result = resolveNodePath(orchDir, orchDir);
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toContain("self-reference");
    }
  });

  it("detects self-reference through symlink", async () => {
    const orchDir = await createNodeDir("orchestrator");
    const linkPath = join(tmpdir(), "fed-symlink-" + Date.now());
    tmpDirs.push(linkPath);
    await symlink(orchDir, linkPath);
    const result = resolveNodePath(linkPath, orchDir);
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toContain("self-reference");
    }
  });

  it("preserves rawPath in result", async () => {
    const result = resolveNodePath("/some/raw/path", "/tmp/orch");
    expect(result.rawPath).toBe("/some/raw/path");
  });
});

describe("resolveAllNodes", () => {
  it("resolves mixed valid and invalid nodes", async () => {
    const validDir = await createNodeDir("engine");
    const orchDir = await createNodeDir("orchestrator");
    const nodes = {
      engine: { path: validDir },
      missing: { path: "/tmp/nonexistent-" + Date.now() },
    };
    const results = resolveAllNodes(nodes, orchDir);
    expect(results.size).toBe(2);

    const engineResult = results.get("engine")!;
    expect(engineResult.resolved).toBe(true);

    const missingResult = results.get("missing")!;
    expect(missingResult.resolved).toBe(false);
  });

  it("resolves entries independently (no deduplication on same path)", async () => {
    const sharedDir = await createNodeDir("shared");
    const orchDir = await createNodeDir("orchestrator");
    const nodes = {
      alpha: { path: sharedDir },
      beta: { path: sharedDir },
    };
    const results = resolveAllNodes(nodes, orchDir);
    expect(results.size).toBe(2);
    expect(results.get("alpha")!.resolved).toBe(true);
    expect(results.get("beta")!.resolved).toBe(true);
  });
});
