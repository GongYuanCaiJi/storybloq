import { describe, it, expect } from "vitest";
import { buildActivePayload } from "../../src/autonomous/status-payload.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";
import type { SessionState } from "../../src/autonomous/session-types.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "aabbccdd-1234-5678-abcd-000000000001",
    state: "IMPLEMENT",
    ticket: { id: "t-abc1234567890123", displayId: "T-042", title: "Team ticket", risk: "low" },
    completedTickets: [
      { id: "t-000000000000prev", displayId: "T-040", title: "Previous ticket" },
      { id: "T-041", title: "Legacy ticket" },
    ],
    resolvedIssues: ["i-issue00000000001"],
    currentIssue: null,
    contextPressure: { level: "low" },
    git: { branch: "feature/team-support" },
    ...overrides,
  };
}

describe("T-382: agent-facing display IDs in status.json", () => {
  describe("buildActivePayload ticket field", () => {
    it("uses cached displayId for ticket", () => {
      const session = makeSession();
      const payload = buildActivePayload(session);
      expect(payload.ticket).toBe("T-042");
    });

    it("falls back to raw id when displayId is missing (legacy)", () => {
      const session = makeSession({
        ticket: { id: "T-005", title: "Legacy", risk: "low" },
      });
      const payload = buildActivePayload(session);
      expect(payload.ticket).toBe("T-005");
    });
  });

  describe("buildActivePayload completedThisSession", () => {
    it("uses cached displayId for completed tickets", () => {
      const session = makeSession();
      const payload = buildActivePayload(session);
      expect(payload.completedThisSession).toContain("T-040");
      expect(payload.completedThisSession).not.toContain("t-000000000000prev");
    });

    it("falls back to raw id for legacy completed tickets without displayId", () => {
      const session = makeSession();
      const payload = buildActivePayload(session);
      expect(payload.completedThisSession).toContain("T-041");
    });
  });

  describe("buildActivePayload resolved issues", () => {
    it("uses resolvedIssueDisplayIds for resolved issues in completedThisSession", () => {
      const session = makeSession({
        resolvedIssueDisplayIds: { "i-issue00000000001": "ISS-077" },
      } as Partial<SessionState>);
      const payload = buildActivePayload(session);
      expect(payload.completedThisSession).toContain("ISS-077");
      expect(payload.completedThisSession).not.toContain("i-issue00000000001");
    });

    it("falls back to raw issue id when no display map entry", () => {
      const session = makeSession();
      const payload = buildActivePayload(session);
      expect(payload.completedThisSession).toContain("i-issue00000000001");
    });
  });

  describe("buildActivePayload currentIssue", () => {
    it("uses cached displayId for currentIssue", () => {
      const session = makeSession({
        currentIssue: { id: "i-curr00000000001", displayId: "ISS-099", title: "Current bug", severity: "high" },
      });
      const payload = buildActivePayload(session);
      expect(payload.currentIssue).toBeTruthy();
      expect(payload.currentIssue!.id).toBe("ISS-099");
    });

    it("falls back to raw id when currentIssue has no displayId", () => {
      const session = makeSession({
        currentIssue: { id: "ISS-005", title: "Legacy issue", severity: "medium" },
      });
      const payload = buildActivePayload(session);
      expect(payload.currentIssue!.id).toBe("ISS-005");
    });
  });

  describe("buildActivePayload targetWork", () => {
    it("uses targetWorkDisplayIds for target work items", () => {
      const session = makeSession({
        targetWork: ["t-abc1234567890123", "i-issue00000000001"],
        targetWorkDisplayIds: {
          "t-abc1234567890123": "T-042",
          "i-issue00000000001": "ISS-077",
        },
      } as Partial<SessionState>);
      const payload = buildActivePayload(session);
      expect(payload.targetWork).toEqual(["T-042", "ISS-077"]);
    });

    it("falls back to raw ids when no display map", () => {
      const session = makeSession({
        targetWork: ["T-001", "ISS-002"],
      });
      const payload = buildActivePayload(session);
      expect(payload.targetWork).toEqual(["T-001", "ISS-002"]);
    });
  });
});

describe("T-382: schema round-trip for new display ID fields", () => {
  const minimalSessionFields = {
    sessionId: "aabbccdd-1234-5678-abcd-000000000001",
    schemaVersion: 1,
    recipe: "coding",
    state: "IMPLEMENT",
    revision: 0,
    startedAt: "2026-05-26T00:00:00Z",
    lease: { lastHeartbeat: "2026-05-26T00:00:00Z", expiresAt: "2026-05-26T01:00:00Z" },
  };

  it("CurrentIssueRef.displayId persists through schema parse", () => {
    const raw = {
      ...minimalSessionFields,
      currentIssue: {
        id: "i-curr00000000001",
        displayId: "ISS-099",
        title: "Bug",
        severity: "high",
      },
    };
    const parsed = SessionStateSchema.parse(raw);
    expect(parsed.currentIssue?.displayId).toBe("ISS-099");
  });

  it("resolvedIssueDisplayIds persists through schema parse", () => {
    const raw = {
      ...minimalSessionFields,
      resolvedIssueDisplayIds: { "i-issue00000000001": "ISS-077" },
    };
    const parsed = SessionStateSchema.parse(raw);
    expect((parsed as Record<string, unknown>).resolvedIssueDisplayIds).toEqual({ "i-issue00000000001": "ISS-077" });
  });

  it("targetWorkDisplayIds persists through schema parse", () => {
    const raw = {
      ...minimalSessionFields,
      targetWorkDisplayIds: { "t-abc1234567890123": "T-042" },
    };
    const parsed = SessionStateSchema.parse(raw);
    expect((parsed as Record<string, unknown>).targetWorkDisplayIds).toEqual({ "t-abc1234567890123": "T-042" });
  });
});

describe("T-382: targeted work display ID rendering", () => {
  it("buildTargetedCandidatesText resolves canonical i-* issue IDs", async () => {
    const { buildTargetedCandidatesText } = await import("../../src/autonomous/target-work.js");
    const { makeState, makeIssue } = await import("../core/test-factories.js");

    const issue = makeIssue({ id: "i-issue00000000001", title: "Team bug", displayId: "ISS-042", severity: "high" });
    const projectState = makeState({ issues: [issue] });

    const result = buildTargetedCandidatesText(["i-issue00000000001"], projectState);
    expect(result.text).toContain("ISS-042");
    expect(result.text).not.toContain("i-issue00000000001");
  });

  it("buildTargetedCandidatesText renders not-found for unresolved IDs", async () => {
    const { buildTargetedCandidatesText } = await import("../../src/autonomous/target-work.js");
    const { makeState } = await import("../core/test-factories.js");

    const projectState = makeState({});
    const result = buildTargetedCandidatesText(["t-nonexistent00000"], projectState);
    expect(result.text).toContain("not found");
  });

  it("buildTargetedPickInstruction uses display IDs in JSON examples", async () => {
    const { buildTargetedPickInstruction } = await import("../../src/autonomous/target-work.js");
    const { makeState, makeTicket } = await import("../core/test-factories.js");

    const ticket = makeTicket({ id: "t-abc1234567890123", title: "Team ticket", displayId: "T-042", status: "open" });
    const projectState = makeState({ tickets: [ticket] });

    const instruction = buildTargetedPickInstruction(["t-abc1234567890123"], projectState, "session-id-here");
    expect(instruction).toContain("T-042");
    expect(instruction).not.toContain("t-abc1234567890123");
  });
});
