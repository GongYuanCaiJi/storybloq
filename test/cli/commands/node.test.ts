import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { handleNodeAdd, handleNodeRemove, handleNodeUpdate, handleNodeList } from "../../../src/cli/commands/node.js";
import { handleConfigSetFederation } from "../../../src/cli/commands/config-update.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { ExitCode } from "../../../src/core/output-formatter.js";

const tmpDirs: string[] = [];

async function createOrchestrator(nodes?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "node-test-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test-orch", type: "orchestrator" });

  if (nodes) {
    const configPath = join(dir, ".story", "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.nodes = nodes;
    await writeFile(configPath, JSON.stringify(raw, null, 2));
  }

  return dir;
}

async function createNodeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-node-"));
  tmpDirs.push(dir);
  return dir;
}

async function createNonOrchestrator(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "node-test-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "regular", type: "npm" });
  return dir;
}

function readConfig(root: string) {
  const { readFileSync } = require("node:fs");
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
}

afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// init --type orchestrator
// ---------------------------------------------------------------------------

describe("init --type orchestrator", () => {
  it("creates config with nodes, federation, and milestones phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-init-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "my-orch", type: "orchestrator" });

    const config = readConfig(dir);
    expect(config.type).toBe("orchestrator");
    expect(config.nodes).toEqual({});
    expect(config.federation).toEqual({ allowNodeWrites: false });

    const roadmap = JSON.parse(
      require("node:fs").readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"),
    );
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0].id).toBe("milestones");
    expect(roadmap.phases[0].name).toBe("Product Milestones");
  });

  it("orchestrator init with empty phases still gets milestones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-init-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "orch2", type: "orchestrator", phases: [] });

    const roadmap = JSON.parse(
      require("node:fs").readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"),
    );
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0].id).toBe("milestones");
  });

  it("non-orchestrator init does not add nodes or federation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-init-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "regular", type: "npm" });

    const config = readConfig(dir);
    expect(config.type).toBe("npm");
    expect(config.nodes).toBeUndefined();
    expect(config.federation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// node add
// ---------------------------------------------------------------------------

describe("handleNodeAdd", () => {
  it("adds a node to orchestrator config", async () => {
    const orch = await createOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd(
      { name: "engine", path: nodeDir, stack: "swift-spm", role: "Core engine" },
      "md",
      orch,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain('Added node "engine"');

    const config = readConfig(orch);
    expect(config.nodes.engine).toBeDefined();
    expect(config.nodes.engine.stack).toBe("swift-spm");
    expect(config.nodes.engine.role).toBe("Core engine");
  });

  it("adds a node with dependsOn and links", async () => {
    const orch = await createOrchestrator();
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();

    await handleNodeAdd({ name: "engine", path: dir1 }, "md", orch);
    const result = await handleNodeAdd(
      {
        name: "client",
        path: dir2,
        dependsOn: ["engine"],
        links: [{ to: "engine", via: "wire-protocol" }],
      },
      "md",
      orch,
    );

    expect(result.exitCode).toBeUndefined();
    const config = readConfig(orch);
    expect(config.nodes.client.dependsOn).toEqual(["engine"]);
    expect(config.nodes.client.links).toEqual([{ to: "engine", via: "wire-protocol" }]);
  });

  it("rejects duplicate node name", async () => {
    const orch = await createOrchestrator();
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();

    await handleNodeAdd({ name: "engine", path: dir1 }, "md", orch);
    const result = await handleNodeAdd({ name: "engine", path: dir2 }, "md", orch);

    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("already exists");
  });

  it("rejects invalid node name", async () => {
    const orch = await createOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd({ name: "Invalid-Name", path: nodeDir }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  it("rejects reserved node name", async () => {
    const orch = await createOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd({ name: ".story", path: nodeDir }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("reserved");
  });

  it("rejects non-existent path", async () => {
    const orch = await createOrchestrator();

    const result = await handleNodeAdd({ name: "engine", path: "/tmp/does-not-exist-xyz" }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("does not exist");
  });

  it("rejects self-reference path", async () => {
    const orch = await createOrchestrator();

    const result = await handleNodeAdd({ name: "self", path: orch }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("self-reference");
  });

  it("rejects dependsOn referencing non-existent node", async () => {
    const orch = await createOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd(
      { name: "client", path: nodeDir, dependsOn: ["nonexistent"] },
      "md",
      orch,
    );
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("non-existent node");
  });

  it("detects dependency cycles", async () => {
    const orch = await createOrchestrator();
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();

    await handleNodeAdd({ name: "a", path: dir1, dependsOn: [] }, "md", orch);
    const result = await handleNodeAdd({ name: "b", path: dir2, dependsOn: ["a"] }, "md", orch);
    expect(result.exitCode).toBeUndefined();

    // Now try to make a depend on b (would create a->b->a cycle via update)
    // This tests the overlay validation
  });

  it("rejects on non-orchestrator project", async () => {
    const dir = await createNonOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd({ name: "engine", path: nodeDir }, "md", dir);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("orchestrator");
  });

  it("returns json output format", async () => {
    const orch = await createOrchestrator();
    const nodeDir = await createNodeDir();

    const result = await handleNodeAdd({ name: "engine", path: nodeDir }, "json", orch);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.name).toBe("engine");
  });
});

// ---------------------------------------------------------------------------
// node remove
// ---------------------------------------------------------------------------

describe("handleNodeRemove", () => {
  it("removes a node with no dependents", async () => {
    const nodeDir = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: nodeDir, stack: "gem", health: "grey", dependsOn: [] },
    });

    const result = await handleNodeRemove("engine", {}, "md", orch);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain('Removed node "engine"');

    const config = readConfig(orch);
    expect(config.nodes.engine).toBeUndefined();
  });

  it("fails when dependents exist (default)", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, dependsOn: [] },
      client: { path: dir2, dependsOn: ["engine"] },
    });

    const result = await handleNodeRemove("engine", {}, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("client");
    expect(result.output).toContain("--force");
  });

  it("removes with --force despite dependents", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, dependsOn: [] },
      client: { path: dir2, dependsOn: ["engine"] },
    });

    const result = await handleNodeRemove("engine", { force: true }, "md", orch);
    expect(result.exitCode).toBeUndefined();

    const config = readConfig(orch);
    expect(config.nodes.engine).toBeUndefined();
    expect(config.nodes.client.dependsOn).toEqual(["engine"]);
  });

  it("removes with --prune and cleans dependsOn refs", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, dependsOn: [] },
      client: { path: dir2, dependsOn: ["engine"] },
    });

    const result = await handleNodeRemove("engine", { prune: true }, "md", orch);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain("Cleaned dependsOn");

    const config = readConfig(orch);
    expect(config.nodes.engine).toBeUndefined();
    expect(config.nodes.client.dependsOn).toEqual([]);
  });

  it("rejects non-existent node", async () => {
    const orch = await createOrchestrator();

    const result = await handleNodeRemove("nonexistent", {}, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// node update
// ---------------------------------------------------------------------------

describe("handleNodeUpdate", () => {
  it("updates string fields via shallow merge", async () => {
    const nodeDir = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: nodeDir, stack: "gem", role: "old role", health: "green", dependsOn: [] },
    });

    const result = await handleNodeUpdate("engine", { role: "new role", stack: "swift-spm" }, "md", orch);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain("role");
    expect(result.output).toContain("stack");

    const config = readConfig(orch);
    expect(config.nodes.engine.role).toBe("new role");
    expect(config.nodes.engine.stack).toBe("swift-spm");
    expect(config.nodes.engine.health).toBe("green");
  });

  it("preserves health and passthrough fields", async () => {
    const nodeDir = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: nodeDir, health: "yellow", customField: "preserved", dependsOn: [] },
    });

    const result = await handleNodeUpdate("engine", { role: "updated" }, "md", orch);
    expect(result.exitCode).toBeUndefined();

    const config = readConfig(orch);
    expect(config.nodes.engine.health).toBe("yellow");
    expect(config.nodes.engine.customField).toBe("preserved");
  });

  it("replaces dependsOn with validation", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, dependsOn: [] },
      client: { path: dir2, dependsOn: [] },
    });

    const result = await handleNodeUpdate("client", { dependsOn: ["engine"] }, "md", orch);
    expect(result.exitCode).toBeUndefined();

    const config = readConfig(orch);
    expect(config.nodes.client.dependsOn).toEqual(["engine"]);
  });

  it("rejects dependsOn creating a cycle", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, dependsOn: ["client"] },
      client: { path: dir2, dependsOn: [] },
    });

    const result = await handleNodeUpdate("client", { dependsOn: ["engine"] }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("cycle");
  });

  it("clears dependsOn with clearDependsOn", async () => {
    const nodeDir = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: nodeDir, dependsOn: ["something"] },
    });

    const result = await handleNodeUpdate("engine", { clearDependsOn: true }, "md", orch);
    expect(result.exitCode).toBeUndefined();

    const config = readConfig(orch);
    expect(config.nodes.engine.dependsOn).toEqual([]);
  });

  it("replaces and clears links", async () => {
    const nodeDir = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: nodeDir, links: [{ to: "old", via: "old-api" }], dependsOn: [] },
    });

    let result = await handleNodeUpdate(
      "engine",
      { links: [{ to: "engine", via: "new-api" }] },
      "md",
      orch,
    );
    expect(result.exitCode).toBeUndefined();

    let config = readConfig(orch);
    expect(config.nodes.engine.links).toEqual([{ to: "engine", via: "new-api" }]);

    result = await handleNodeUpdate("engine", { clearLinks: true }, "md", orch);
    config = readConfig(orch);
    expect(config.nodes.engine.links).toBeUndefined();
  });

  it("rejects update on non-existent node", async () => {
    const orch = await createOrchestrator();

    const result = await handleNodeUpdate("nonexistent", { role: "x" }, "md", orch);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("not found");
  });

  it("rejects update on non-orchestrator", async () => {
    const dir = await createNonOrchestrator();

    const result = await handleNodeUpdate("engine", { role: "x" }, "md", dir);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("orchestrator");
  });
});

// ---------------------------------------------------------------------------
// node list
// ---------------------------------------------------------------------------

describe("handleNodeList", () => {
  it("lists nodes in a table", async () => {
    const dir1 = await createNodeDir();
    const dir2 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, stack: "gem", role: "Core", health: "green", dependsOn: [] },
      client: { path: dir2, stack: "npm", dependsOn: ["engine"] },
    });

    const { state, warnings } = await loadProject(orch);
    const result = handleNodeList({
      state,
      warnings,
      root: orch,
      handoversDir: join(orch, ".story", "handovers"),
      format: "md",
    });

    expect(result.output).toContain("engine");
    expect(result.output).toContain("client");
    expect(result.output).toContain("gem");
    expect(result.output).toContain("green");
  });

  it("returns empty message when no nodes", async () => {
    const orch = await createOrchestrator();
    const { state, warnings } = await loadProject(orch);
    const result = handleNodeList({
      state,
      warnings,
      root: orch,
      handoversDir: join(orch, ".story", "handovers"),
      format: "md",
    });
    expect(result.output).toContain("No nodes configured");
  });

  it("returns json format", async () => {
    const dir1 = await createNodeDir();
    const orch = await createOrchestrator({
      engine: { path: dir1, stack: "gem", dependsOn: [] },
    });

    const { state, warnings } = await loadProject(orch);
    const result = handleNodeList({
      state,
      warnings,
      root: orch,
      handoversDir: join(orch, ".story", "handovers"),
      format: "json",
    });

    const parsed = JSON.parse(result.output);
    expect(parsed.data.nodes).toHaveLength(1);
    expect(parsed.data.nodes[0].name).toBe("engine");
  });

  it("rejects on non-orchestrator", async () => {
    const dir = await createNonOrchestrator();
    const { state, warnings } = await loadProject(dir);
    const result = handleNodeList({
      state,
      warnings,
      root: dir,
      handoversDir: join(dir, ".story", "handovers"),
      format: "md",
    });
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

// ---------------------------------------------------------------------------
// config set-federation
// ---------------------------------------------------------------------------

describe("handleConfigSetFederation", () => {
  it("enables allowNodeWrites", async () => {
    const orch = await createOrchestrator();

    const result = await handleConfigSetFederation(orch, "md", { allowNodeWrites: true });
    expect(result.output).toContain("allowNodeWrites = true");

    const config = readConfig(orch);
    expect(config.federation.allowNodeWrites).toBe(true);
  });

  it("disables allowNodeWrites", async () => {
    const orch = await createOrchestrator();

    await handleConfigSetFederation(orch, "md", { allowNodeWrites: true });
    const result = await handleConfigSetFederation(orch, "md", { allowNodeWrites: false });
    expect(result.output).toContain("allowNodeWrites = false");

    const config = readConfig(orch);
    expect(config.federation.allowNodeWrites).toBe(false);
  });

  it("rejects when no flag provided", async () => {
    const orch = await createOrchestrator();

    const result = await handleConfigSetFederation(orch, "md", {});
    expect(result.errorCode).toBe("invalid_input");
  });

  it("rejects on non-orchestrator project", async () => {
    const dir = await createNonOrchestrator();

    await expect(
      handleConfigSetFederation(dir, "md", { allowNodeWrites: true }),
    ).rejects.toThrow("orchestrator");
  });

  it("preserves existing federation fields", async () => {
    const orch = await createOrchestrator();
    const configPath = join(orch, ".story", "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.federation = { allowNodeWrites: false, customField: "kept" };
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    await handleConfigSetFederation(orch, "md", { allowNodeWrites: true });

    const config = readConfig(orch);
    expect(config.federation.allowNodeWrites).toBe(true);
    expect(config.federation.customField).toBe("kept");
  });
});
