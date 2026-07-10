import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluatePressure,
  pressureAfterCompaction,
  pressureMeetsThreshold,
} from "../../../src/autonomous/context-pressure.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import {
  isStageAdvance,
  StageContext,
  type ResolvedRecipe,
  type StageAdvance,
  type StageResult,
} from "../../../src/autonomous/stages/types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "COMPLETE",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 5,
      ticketsCompleted: 1,
      compactionCount: 0,
      eventsLogBytes: 0,
      workItemsAtLastCompaction: 0,
      eventsLogBytesAtLastCompaction: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 5,
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
      handoverInterval: 5,
    },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
  };
}

function instructionOf(result: StageResult | StageAdvance): string {
  if (!isStageAdvance(result)) return result.instruction;
  return "result" in result ? result.result?.instruction ?? "" : "";
}

describe("context-pressure compaction policy", () => {
  it("compares pressure levels against supported thresholds", () => {
    expect(pressureMeetsThreshold("medium", "medium")).toBe(true);
    expect(pressureMeetsThreshold("medium", "high")).toBe(false);
    expect(pressureMeetsThreshold("high", "high")).toBe(true);
    expect(pressureMeetsThreshold("high", "critical")).toBe(false);
    expect(pressureMeetsThreshold("critical", "critical")).toBe(true);
  });

  it("preserves the existing high fallback for unknown and legacy values", () => {
    expect(pressureMeetsThreshold("medium", "low")).toBe(false);
    expect(pressureMeetsThreshold("high", "low")).toBe(true);
    expect(pressureMeetsThreshold("medium", "unknown")).toBe(false);
    expect(pressureMeetsThreshold("high", undefined)).toBe(true);
  });

  it("resets pressure against cumulative work after successful compaction", () => {
    const before = makeState({
      completedTickets: Array.from({ length: 5 }, (_, index) => ({ id: `T-${index}` })),
      resolvedIssues: ["ISS-001"],
      contextPressure: {
        level: "high",
        guideCallCount: 60,
        ticketsCompleted: 6,
        compactionCount: 2,
        eventsLogBytes: 900_000,
      },
    });

    const contextPressure = pressureAfterCompaction(before);
    const resumed = { ...before, guideCallCount: 0, contextPressure } as FullSessionState;

    expect(contextPressure.compactionCount).toBe(3);
    expect(contextPressure.workItemsAtLastCompaction).toBe(6);
    expect(contextPressure.eventsLogBytesAtLastCompaction).toBe(900_000);
    expect(evaluatePressure(resumed)).toBe("low");
  });
});

describe("CompleteStage pressure compaction", () => {
  let root: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "complete-pressure-"));
    sessionDir = join(root, ".story", "sessions", "test-session");
    for (const dir of ["tickets", "issues", "notes", "lessons", "handovers", "sessions/test-session"]) {
      mkdirSync(join(root, ".story", dir), { recursive: true });
    }
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
      version: 1,
      schemaVersion: 1,
      project: "test",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [],
      blockers: [],
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addOpenWork(): void {
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001",
      title: "Open bug",
      status: "open",
      severity: "medium",
      components: [],
      impact: "Needs fixing.",
      resolution: null,
      resolvedDate: null,
      discoveredDate: "2026-01-01",
      relatedTickets: [],
      location: [],
    }));
  }

  it("continues to PICK_TICKET below the threshold", async () => {
    addOpenWork();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("PICK_TICKET");
    }
  });

  it("requests pre_compact at high pressure without ending the session", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(false);
    expect(instructionOf(result)).toContain("Context Compaction Required");
    expect(instructionOf(result)).toContain('"action": "pre_compact"');
    if (!isStageAdvance(result)) expect(result.contextAdvice).toBe("compact-now");
    expect(ctx.state.state).toBe("COMPLETE");
    expect(ctx.state.status).toBe("active");
  });

  it("waits for critical pressure when configured conservatively", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 90,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
      config: {
        maxTicketsPerSession: 0,
        compactThreshold: "critical",
        reviewBackends: ["codex", "agent"],
        handoverInterval: 5,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
  });

  it("requests compaction at critical pressure under the critical threshold", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 130,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
      config: {
        maxTicketsPerSession: 0,
        compactThreshold: "critical",
        reviewBackends: ["codex", "agent"],
        handoverInterval: 5,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(false);
    expect(instructionOf(result)).toContain("Context Compaction Required");
  });

  it("lets normal end-of-work HANDOVER win over pressure compaction", async () => {
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("HANDOVER");
    }
    expect(instructionOf(result)).not.toContain("Context Compaction Required");
  });

  it("repeats the pre_compact instruction when COMPLETE receives a report", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.report(ctx, { completedAction: "acknowledged" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain('"action": "pre_compact"');
    }
  });
});
