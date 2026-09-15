import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject } from "../../src/core/project-loader.js";
import { buildCompactStatusData } from "../../src/core/output-formatter.js";
import {
  extractRecord,
  projectSidebar,
  type SidebarInput,
  type SidebarTicket,
  type SidebarIssue,
} from "../../plugins/storybloq/hooks/sidebar-projection.js";

/**
 * T-508: the ledger sidebar Mod's projection, checked against the one the CLI
 * already ships.
 *
 * The sidebar cannot import `src/core`. The client admits a hooks module's own
 * files by relative path and "claude-code" and refuses everything else, so the
 * projection lives inside the plugin folder and this test is what keeps it
 * from drifting: it loads one fixture `.story/` twice, once through
 * `loadProject` into `buildCompactStatusData` (what `storybloq status
 * --compact` prints) and once through the plugin's own pure projection, and
 * asserts the numbers agree. Change a counting rule on either side and this
 * goes red, which is the point (mutant M-PROJECTION-DRIFT).
 *
 * The fixture is deliberately awkward: an umbrella with children (so leaf
 * counting has something to get wrong), a blocked ticket whose blocker is
 * named by displayId, a blocker that does not exist at all (conservatively
 * blocked), a deleted ticket and a deleted issue (lifecycle), and a resolved
 * issue. Every one of those is a rule the projection has to reproduce rather
 * than approximate.
 */

const config = {
  version: 2,
  project: "sidebar-fixture",
  type: "npm",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
};

const roadmap = {
  title: "sidebar-fixture",
  date: "2026-01-01",
  phases: [
    { id: "p1", label: "P1", name: "Phase One", description: "First." },
    { id: "p2", label: "P2", name: "Phase Two", description: "Second." },
    { id: "p3", label: "P3", name: "Phase Three", description: "Third." },
  ],
  blockers: [],
};

function ticket(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "A ticket",
    description: "Body.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    ...over,
  };
}

function issue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "An issue",
    status: "open",
    severity: "medium",
    components: ["core"],
    impact: "Impact.",
    resolution: null,
    location: ["file.ts:1"],
    discoveredDate: "2026-01-01",
    resolvedDate: null,
    relatedTickets: [],
    ...over,
  };
}

const tickets: Record<string, Record<string, unknown>> = {
  // An umbrella: a parent is never a leaf, so it must not be counted.
  "T-001.json": ticket({ id: "T-001", title: "Umbrella", phase: "p1", order: 1 }),
  "T-002.json": ticket({ id: "T-002", title: "Child complete", parentTicket: "T-001", status: "complete", phase: "p1", order: 2 }),
  "T-003.json": ticket({ id: "T-003", title: "Child in progress", parentTicket: "T-001", status: "inprogress", phase: "p1", order: 3 }),
  // Phase two: one complete, one blocked by a displayId reference.
  "T-004.json": ticket({ id: "T-004", title: "Done", status: "complete", phase: "p2", order: 4 }),
  "t-zz11yy22xx33ww44.json": ticket({ id: "t-zz11yy22xx33ww44", displayId: "T-005", title: "Blocked by a display id", status: "open", phase: "p2", order: 5, blockedBy: ["T-003"] }),
  // Phase three: nothing started, plus a blocker that does not resolve at all.
  "T-006.json": ticket({ id: "T-006", title: "Blocked by a ghost", status: "open", phase: "p3", order: 6, blockedBy: ["T-999"] }),
  // Deleted: out of every count.
  "T-007.json": ticket({ id: "T-007", title: "Deleted", status: "open", phase: "p3", order: 7, lifecycle: "deleted" }),
  // A displayId collision, which is what `storybloq reconcile` exists for.
  // Two tickets answer to T-010 and a third used to, and a fourth names T-010
  // as its parent. The CLI's parent resolution falls through the ambiguous
  // displayId to the unique previous one, so the THIRD is the umbrella; a
  // resolver that stops at "ambiguous" leaves it counted as a leaf.
  "t-aa11aa11aa11aa11.json": ticket({ id: "t-aa11aa11aa11aa11", displayId: "T-010", title: "Collides one", status: "open", phase: "p3", order: 10 }),
  "t-bb22bb22bb22bb22.json": ticket({ id: "t-bb22bb22bb22bb22", displayId: "T-010", title: "Collides two", status: "open", phase: "p3", order: 11 }),
  "t-cc33cc33cc33cc33.json": ticket({ id: "t-cc33cc33cc33cc33", displayId: "T-011", previousDisplayIds: ["T-010"], title: "Renamed away from T-010", status: "open", phase: "p3", order: 12 }),
  "T-013.json": ticket({ id: "T-013", title: "Child of the renamed one", parentTicket: "T-010", status: "open", phase: "p3", order: 13 }),
};

const issues: Record<string, Record<string, unknown>> = {
  "ISS-001.json": issue({ id: "ISS-001", title: "Critical one", severity: "critical" }),
  "ISS-002.json": issue({ id: "ISS-002", title: "High one", severity: "high", status: "inprogress" }),
  "ISS-003.json": issue({ id: "ISS-003", title: "Medium one", severity: "medium" }),
  "ISS-004.json": issue({ id: "ISS-004", title: "Resolved one", severity: "low", status: "resolved", resolvedDate: "2026-01-02" }),
  "ISS-005.json": issue({ id: "ISS-005", title: "Deleted one", severity: "low", lifecycle: "deleted" }),
};

const handovers: Record<string, string> = {
  "2026-01-01-first.md": "# First",
  "2026-01-03-latest.md": "# Latest",
  "2026-01-02-middle.md": "# Middle",
};

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-sidebar-"));
  const storyDir = join(root, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await writeFile(join(storyDir, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify(roadmap, null, 2));
  for (const [name, data] of Object.entries(tickets)) {
    await writeFile(join(storyDir, "tickets", name), JSON.stringify(data, null, 2));
  }
  for (const [name, data] of Object.entries(issues)) {
    await writeFile(join(storyDir, "issues", name), JSON.stringify(data, null, 2));
  }
  for (const [name, text] of Object.entries(handovers)) {
    await writeFile(join(storyDir, "handovers", name), text);
  }
  return root;
}

/**
 * Reads the fixture the way the Mod does: one text per file, then
 * `extractRecord` per text. Nothing here knows a counting rule; that is the
 * projection's job, which is what makes the equality below meaningful.
 */
async function readAsTheModDoes(root: string): Promise<SidebarInput> {
  const storyDir = join(root, ".story");
  const ticketTexts: string[] = [];
  for (const name of await readdir(join(storyDir, "tickets"))) {
    ticketTexts.push(await readFile(join(storyDir, "tickets", name), "utf8"));
  }
  const issueTexts: string[] = [];
  for (const name of await readdir(join(storyDir, "issues"))) {
    issueTexts.push(await readFile(join(storyDir, "issues", name), "utf8"));
  }
  const parsedTickets: SidebarTicket[] = [];
  for (const text of ticketTexts) {
    const record = extractRecord("ticket", text);
    if (record) parsedTickets.push(record as SidebarTicket);
  }
  const parsedIssues: SidebarIssue[] = [];
  for (const text of issueTexts) {
    const record = extractRecord("issue", text);
    if (record) parsedIssues.push(record as SidebarIssue);
  }
  const roadmapDoc = JSON.parse(await readFile(join(storyDir, "roadmap.json"), "utf8")) as {
    phases: readonly { id: string; name: string }[];
  };
  const configDoc = JSON.parse(await readFile(join(storyDir, "config.json"), "utf8")) as {
    project: string;
  };
  return {
    project: configDoc.project,
    phases: roadmapDoc.phases.map((p) => ({ id: p.id, name: p.name })),
    tickets: parsedTickets,
    issues: parsedIssues,
    handoverFilenames: (await readdir(join(storyDir, "handovers"))).slice(),
  };
}

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("sidebar projection (T-508)", () => {
  it("counts tickets, issues and phases exactly as status --compact does", async () => {
    root = await writeFixture();
    const { state } = await loadProject(root);
    const compact = buildCompactStatusData(state, [], [], undefined, [], undefined, [], {
      items: [],
      warnings: [],
    });
    const mine = projectSidebar(await readAsTheModDoes(root));

    expect(mine.project).toBe(compact.project);
    expect(mine.totalTickets).toBe(compact.totalTickets);
    expect(mine.completeTickets).toBe(compact.completeTickets);
    expect(mine.openTickets).toBe(compact.openTickets);
    expect(mine.blockedTickets).toBe(compact.blockedTickets);
    expect(mine.openIssues).toBe(compact.openIssues);
    expect(mine.phases).toEqual(
      compact.phases.map((p) => ({ id: p.id, name: p.name, status: p.status, leafCount: p.leafCount })),
    );
  });

  it("is checked against numbers the fixture actually has, not against zero", async () => {
    // Guards the equality above: two projections that both return nothing
    // agree perfectly. These are the fixture's real figures, read off the
    // rules rather than off either implementation.
    root = await writeFixture();
    const { state } = await loadProject(root);
    const compact = buildCompactStatusData(state, [], [], undefined, [], undefined, [], {
      items: [],
      warnings: [],
    });
    // T-001 is an umbrella, T-007 is deleted, and t-cc33 is an umbrella too
    // because T-013's parent ref T-010 resolves through the historical
    // displayId: eight leaves remain.
    expect(compact.totalTickets).toBe(8);
    expect(compact.completeTickets).toBe(2);
    expect(compact.openTickets).toBe(6);
    // t-zz11yy22xx33ww44 is blocked by T-003 (in progress) and T-006 by a ghost ref.
    expect(compact.blockedTickets).toBe(2);
    // ISS-004 is resolved and ISS-005 is deleted: three remain.
    expect(compact.openIssues).toBe(3);
    expect(compact.phases.map((p) => p.status)).toEqual(["inprogress", "inprogress", "notstarted"]);
  });

  it("resolves a parent through a historical displayId when the current one collides", async () => {
    // The rule this pins, from ProjectState's localResolve: id, then a
    // displayId matching exactly one ticket, then a previousDisplayIds
    // matching exactly one. An ambiguous displayId does not end the search.
    // M-PARENT-AMBIGUOUS returns ambiguous there and this goes red.
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    const leafIds = mine.inProgressTickets.map((t) => t.id);
    expect(leafIds).not.toContain("T-011");
    const { state } = await loadProject(root);
    expect(state.isUmbrella(state.tickets.find((t) => t.id === "t-cc33cc33cc33cc33")!)).toBe(true);
    expect(mine.totalTickets).toBe(8);
  });

  it("counts open issues by severity", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.issuesBySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
  });

  it("names the in-progress leaf tickets, and never an umbrella", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.inProgressTickets.map((t) => t.id)).toEqual(["T-003"]);
  });

  it("takes the newest handover by filename, not the newest read", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.latestHandover).toBe("2026-01-03-latest.md");
  });

  it("names the first phase still in progress as the current one", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.currentPhase?.id).toBe("p1");
  });

  it("truncates a title at extraction, so the store stays small", async () => {
    const long = "x".repeat(400);
    const record = extractRecord("ticket", JSON.stringify(ticket({ id: "T-100", title: long })));
    expect(record).not.toBeNull();
    expect(record!.title.length).toBeLessThanOrEqual(80);
  });

  it("returns null for a text that is not a record, rather than throwing", () => {
    expect(extractRecord("ticket", "{not json")).toBeNull();
    expect(extractRecord("ticket", JSON.stringify({ title: "no id" }))).toBeNull();
    expect(extractRecord("issue", JSON.stringify({ id: "ISS-9" }))).toBeNull();
  });
});
