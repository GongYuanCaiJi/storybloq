import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossNodeBlockingResolver } from "../../src/federation/cross-node-resolver.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

function makeTicketWithCrossRef(id: string, crossRefs: string[]): Ticket {
  return {
    id,
    title: "Test ticket",
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    crossNodeBlockedBy: crossRefs,
  } as Ticket;
}

function makeTicketNoCrossRef(id: string): Ticket {
  return {
    id,
    title: "Test ticket",
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
  } as Ticket;
}

async function createNodeWithTickets(
  name: string,
  tickets: Array<{ id: string; status: string }>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-xnode-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  await writeFile(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));

  for (const t of tickets) {
    await writeFile(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: `${name} ticket`, description: "", type: "task",
      status: t.status, phase: null, order: 10, blockedBy: [],
      createdDate: "2026-01-01", completedDate: t.status === "complete" ? "2026-05-01" : null,
    }));
  }

  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("CrossNodeBlockingResolver", () => {
  describe("build + isCrossNodeBlocked", () => {
    it("returns false for ticket with no crossNodeBlockedBy", async () => {
      const ticket = makeTicketNoCrossRef("T-001");
      const resolvedNodes = new Map<string, ResolvedNode>();
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("returns false when cross-node ref points to complete remote ticket", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "complete" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("returns true when cross-node ref points to open remote ticket", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "open" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("returns 'unresolved' when node is inaccessible", async () => {
      const ticket = makeTicketWithCrossRef("T-001", ["broken:T-001"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["broken", { resolved: false, reason: "path does not exist", rawPath: "/missing" }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe("unresolved");
    });

    it("returns true when any cross-node ref is blocking (mixed refs)", async () => {
      const nodeDir = await createNodeWithTickets("engine", [
        { id: "T-061", status: "complete" },
        { id: "T-062", status: "open" },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061", "engine:T-062"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });
  });

  describe("getCrossNodeStatus", () => {
    it("returns status for a valid ref", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "complete" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      const status = resolver.getCrossNodeStatus("engine:T-061");
      expect(status).toBeDefined();
      if (status?.resolved) {
        expect(status.status).toBe("complete");
      }
    });

    it("returns undefined for unknown ref", async () => {
      const resolver = await CrossNodeBlockingResolver.build([], new Map());
      expect(resolver.getCrossNodeStatus("engine:T-999")).toBeUndefined();
    });
  });
});
