import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanNodeSummary, scanAllSummaries } from "../../src/federation/scanner.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

async function createNodeProject(opts: {
  name?: string;
  tickets?: Array<{ id: string; status: string }>;
  issues?: Array<{ id: string; status: string; severity: string }>;
  handovers?: string[];
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-scanner-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });

  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: opts.name ?? "test-node",
      type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  await writeFile(
    join(storyDir, "roadmap.json"),
    JSON.stringify({ version: 2, phases: [], blockers: [] }),
  );

  for (const t of opts.tickets ?? []) {
    await writeFile(
      join(storyDir, "tickets", `${t.id}.json`),
      JSON.stringify({
        id: t.id, title: "Test ticket", type: "task",
        status: t.status, phase: null, order: 10, blockedBy: [],
        description: "", parentTicket: null, created: "2026-01-01",
      }),
    );
  }

  for (const iss of opts.issues ?? []) {
    await writeFile(
      join(storyDir, "issues", `${iss.id}.json`),
      JSON.stringify({
        id: iss.id, title: "Test issue", status: iss.status,
        severity: iss.severity, impact: "test", relatedTickets: [],
        created: "2026-01-01",
      }),
    );
  }

  for (const h of opts.handovers ?? []) {
    await writeFile(join(storyDir, "handovers", h), `# Handover\nContent`);
  }

  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("scanNodeSummary", () => {
  it("returns correct counts for a node with tickets and issues", async () => {
    const dir = await createNodeProject({
      name: "engine",
      tickets: [
        { id: "T-001", status: "complete" },
        { id: "T-002", status: "open" },
        { id: "T-003", status: "inprogress" },
      ],
      issues: [
        { id: "ISS-001", status: "open", severity: "high" },
        { id: "ISS-002", status: "resolved", severity: "low" },
      ],
    });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.project).toBe("engine");
    expect(result.ticketCount).toBe(3);
    expect(result.completeTickets).toBe(1);
    expect(result.openTickets).toBe(1);
    expect(result.issueCount).toBe(2);
    expect(result.openIssues).toBe(1);
  });

  it("handles empty tickets/issues directories", async () => {
    const dir = await createNodeProject({ name: "empty" });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.ticketCount).toBe(0);
    expect(result.issueCount).toBe(0);
  });

  it("tolerates corrupt ticket JSON", async () => {
    const dir = await createNodeProject({ name: "corrupt" });
    await writeFile(join(dir, ".story", "tickets", "T-BAD.json"), "{ invalid }");
    await writeFile(
      join(dir, ".story", "tickets", "T-001.json"),
      JSON.stringify({
        id: "T-001", title: "Good", type: "task", status: "open",
        phase: null, order: 10, blockedBy: [], description: "",
        parentTicket: null, created: "2026-01-01",
      }),
    );
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.ticketCount).toBe(1);
  });

  it("reads latest handover info", async () => {
    const dir = await createNodeProject({
      name: "with-handovers",
      handovers: ["2026-05-01-session.md", "2026-05-10-feature.md"],
    });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.lastHandoverDate).toBeTruthy();
  });
});

describe("scanAllSummaries", () => {
  it("scans multiple nodes concurrently", async () => {
    const dir1 = await createNodeProject({
      name: "engine",
      tickets: [{ id: "T-001", status: "complete" }],
    });
    const dir2 = await createNodeProject({
      name: "cloud",
      tickets: [{ id: "T-001", status: "open" }, { id: "T-002", status: "open" }],
    });

    const nodes = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: dir1, storyDir: join(dir1, ".story"), rawPath: dir1 }],
      ["cloud", { resolved: true, absolutePath: dir2, storyDir: join(dir2, ".story"), rawPath: dir2 }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);

    const engineResult = results.get("engine")!;
    expect(engineResult.reachable).toBe(true);
    if (engineResult.reachable) {
      expect(engineResult.summary.ticketCount).toBe(1);
    }

    const cloudResult = results.get("cloud")!;
    expect(cloudResult.reachable).toBe(true);
    if (cloudResult.reachable) {
      expect(cloudResult.summary.ticketCount).toBe(2);
    }
  });

  it("skips unresolved nodes", async () => {
    const dir = await createNodeProject({ name: "engine" });
    const nodes = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
      ["missing", { resolved: false, reason: "not found", rawPath: "/missing" }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);

    const missingResult = results.get("missing")!;
    expect(missingResult.reachable).toBe(false);
    if (!missingResult.reachable) {
      expect(missingResult.reason).toBeTruthy();
    }
  });

  it("handles all nodes being unreachable", async () => {
    const nodes = new Map<string, ResolvedNode>([
      ["a", { resolved: false, reason: "not found", rawPath: "/a" }],
      ["b", { resolved: false, reason: "not found", rawPath: "/b" }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);
    for (const [, result] of results) {
      expect(result.reachable).toBe(false);
    }
  });
});
