import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNodeRoot,
  checkNodeWritePermission,
  withNodeReadResolution,
  withNodeWriteResolution,
  type McpToolResult,
} from "../../src/mcp/node-resolution.js";

const tmpDirs: string[] = [];

async function createOrchestratorProject(opts: {
  nodes?: Record<string, { path: string }>;
  allowNodeWrites?: boolean;
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-node-res-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  const nodesConfig: Record<string, Record<string, unknown>> = {};
  for (const [name, node] of Object.entries(opts.nodes ?? {})) {
    nodesConfig[name] = { path: node.path, health: "grey", dependsOn: [], stack: "", role: "", summary: "" };
  }

  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: "orchestrator", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: nodesConfig,
      federation: { allowNodeWrites: opts.allowNodeWrites ?? false },
    }, null, 2),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));
  return dir;
}

async function createNodeProject(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-node-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });
  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("resolveNodeRoot", () => {
  it("returns resolved root for valid node", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    const result = resolveNodeRoot(orchDir, "engine");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root).toBeTruthy();
    }
  });

  it("returns error for non-orchestrator config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-non-orch-"));
    tmpDirs.push(dir);
    const storyDir = join(dir, ".story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "config.json"), JSON.stringify({
      version: 2, project: "regular", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    const result = resolveNodeRoot(dir, "engine");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("not_orchestrator");
    }
  });

  it("returns error for unknown node name", async () => {
    const orchDir = await createOrchestratorProject({ nodes: {} });
    const result = resolveNodeRoot(orchDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("node_not_found");
    }
  });

  it("returns error for unresolvable node path", async () => {
    const orchDir = await createOrchestratorProject({
      nodes: { broken: { path: join(tmpdir(), "fed-nonexistent-" + Date.now() + "-" + Math.random().toString(36).slice(2)) } },
    });
    const result = resolveNodeRoot(orchDir, "broken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("node_unresolvable");
    }
  });
});

describe("checkNodeWritePermission", () => {
  it("returns false by default", async () => {
    const orchDir = await createOrchestratorProject();
    expect(checkNodeWritePermission(orchDir)).toBe(false);
  });

  it("returns true when federation.allowNodeWrites is true", async () => {
    const orchDir = await createOrchestratorProject({ allowNodeWrites: true });
    expect(checkNodeWritePermission(orchDir)).toBe(true);
  });
});

describe("withNodeReadResolution", () => {
  it("passes pinnedRoot when no node arg", async () => {
    const orchDir = await createOrchestratorProject();
    let receivedRoot = "";
    const mockResult: McpToolResult = { content: [{ type: "text", text: "ok" }] };
    await withNodeReadResolution(orchDir, undefined, async (root) => {
      receivedRoot = root;
      return mockResult;
    });
    expect(receivedRoot).toBe(orchDir);
  });

  it("passes resolved node root for valid node", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    let receivedRoot = "";
    const mockResult: McpToolResult = { content: [{ type: "text", text: "ok" }] };
    await withNodeReadResolution(orchDir, "engine", async (root) => {
      receivedRoot = root;
      return mockResult;
    });
    expect(receivedRoot).not.toBe(orchDir);
    expect(receivedRoot).toBeTruthy();
  });

  it("returns error for unknown node", async () => {
    const orchDir = await createOrchestratorProject();
    const result = await withNodeReadResolution(orchDir, "missing", async () => {
      return { content: [{ type: "text", text: "should not reach" }] };
    });
    expect(result.content[0]!.text).toContain("not found");
  });
});

describe("withNodeWriteResolution", () => {
  it("blocks write when allowNodeWrites is false", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({
      nodes: { engine: { path: nodeDir } },
      allowNodeWrites: false,
    });
    const result = await withNodeWriteResolution(orchDir, "engine", async () => {
      return { content: [{ type: "text", text: "should not reach" }] };
    });
    expect(result.content[0]!.text).toContain("writes disabled");
  });

  it("allows write when allowNodeWrites is true", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({
      nodes: { engine: { path: nodeDir } },
      allowNodeWrites: true,
    });
    let receivedRoot = "";
    await withNodeWriteResolution(orchDir, "engine", async (root) => {
      receivedRoot = root;
      return { content: [{ type: "text", text: "ok" }] };
    });
    expect(receivedRoot).not.toBe(orchDir);
    expect(receivedRoot).toBeTruthy();
  });

  it("passes pinnedRoot when no node arg", async () => {
    const orchDir = await createOrchestratorProject();
    let receivedRoot = "";
    await withNodeWriteResolution(orchDir, undefined, async (root) => {
      receivedRoot = root;
      return { content: [{ type: "text", text: "ok" }] };
    });
    expect(receivedRoot).toBe(orchDir);
  });
});
