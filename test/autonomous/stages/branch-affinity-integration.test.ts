/**
 * T-328: Branch affinity integration tests.
 * Tests mismatch blocking in report(), targeted mode bypass,
 * annotation injection in enter(), and config propagation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import { resolveRecipe } from "../../../src/autonomous/recipes/loader.js";
import { gitCheckRefFormat } from "../../../src/autonomous/git-inspector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides?: Partial<ResolvedRecipe>): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ...overrides,
  };
}

function setupProject(root: string, options?: {
  tickets?: Array<{ id: string; title: string; status: string; phase: string; blockedBy?: string[] }>;
  issues?: Array<{ id: string; title: string; status: string; severity: string }>;
}): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-04-03",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));

  for (const t of options?.tickets ?? []) {
    writeFileSync(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: t.title, type: "task", status: t.status, phase: t.phase,
      order: 10, description: "", createdDate: "2026-04-03", completedDate: null,
      blockedBy: t.blockedBy ?? [], parentTicket: null,
    }));
  }
  for (const i of options?.issues ?? []) {
    writeFileSync(join(storyDir, "issues", `${i.id}.json`), JSON.stringify({
      id: i.id, title: i.title, status: i.status, severity: i.severity,
      components: [], impact: "test", resolution: null, location: [],
      discoveredDate: "2026-04-03", resolvedDate: null, relatedTickets: [], order: 10,
    }));
  }
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-branch-affinity-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Mismatch blocking in report()
// ---------------------------------------------------------------------------

describe("mismatch blocking in PickTicketStage.report()", () => {
  it("routes to HANDOVER when pick does not match branch entity", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-100", title: "Branch ticket", status: "open", phase: "p1" },
        { id: "T-200", title: "Other ticket", status: "open", phase: "p1" },
      ],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    expect((result as any).result.instruction).toContain("T-100");
    expect((result as any).result.instruction).toContain("T-200");
  });

  it("allows pick when it matches branch entity", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Branch ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block when on main branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Any ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block in targeted mode even with mismatched branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Target ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
      targetWork: ["T-200"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block when branchStrategy is per-ticket", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Other ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
      resolvedBranchStrategy: "per-ticket",
    } as any);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ branchStrategy: "per-ticket" }));
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    // Should NOT route to HANDOVER (per-ticket skips mismatch blocking)
    expect(result).not.toHaveProperty("target", "HANDOVER");
  });

  it("blocks issue pick that does not match branch entity", async () => {
    setupProject(testRoot, {
      issues: [{ id: "ISS-050", title: "Some issue", status: "open", severity: "high" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-050" } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
  });
});

// ---------------------------------------------------------------------------
// Annotation in enter()
// ---------------------------------------------------------------------------

describe("annotation in PickTicketStage.enter()", () => {
  it("includes branch affinity annotation when on a feature branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Branch ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).toContain("[Branch affinity]");
    expect(instruction).toContain("T-100");
  });

  it("does not include annotation when on main", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Some ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).not.toContain("[Branch affinity]");
  });

  it("includes ambiguous warning when branch has multiple IDs", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "feature/T-100-and-T-200", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).toContain("[Branch warning]");
  });
});

// ---------------------------------------------------------------------------
// Config propagation
// ---------------------------------------------------------------------------

describe("resolveRecipe branchStrategy propagation", () => {
  it("defaults to 'none' when not specified", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.branchStrategy).toBe("none");
  });

  it("project override wins over recipe default", () => {
    const recipe = resolveRecipe("coding", { branchStrategy: "per-ticket" });
    expect(recipe.branchStrategy).toBe("per-ticket");
  });

  it("recipe default is 'none' in coding.json", () => {
    const recipe = resolveRecipe("coding", {});
    expect(recipe.branchStrategy).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// gitCheckRefFormat
// ---------------------------------------------------------------------------

describe("gitCheckRefFormat", () => {
  it("returns true for valid branch names", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/T-123-valid-name");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(true);
  });

  it("returns false for invalid branch names", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/T-123..invalid");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });

  it("returns false for branch names with spaces", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/has space");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });
});
