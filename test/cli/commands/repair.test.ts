import { describe, it, expect } from "vitest";
import { computeRepairs } from "../../../src/cli/commands/repair.js";
import { makeState, makeTicket, makeIssue, makeRoadmap, makePhase } from "../../core/test-factories.js";

describe("computeRepairs", () => {
  const phase = makePhase({ id: "p1" });
  const roadmap = makeRoadmap([phase]);

  it("returns empty fixes for clean project", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001"], phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes).toHaveLength(0);
    expect(result.patches).toHaveLength(0);
  });

  it("fixes issue with stale relatedTickets", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001", "T-999"] })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]!.entity).toBe("ISS-001");
    expect(result.fixes[0]!.field).toBe("relatedTickets");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!).toEqual({ id: "ISS-001", type: "issue", set: { relatedTickets: ["T-001"] }, unset: [] });
  });

  it("fixes issue with stale phase", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", phase: "nonexistent" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "ISS-001" && f.field === "phase")).toBe(true);
  });

  it("fixes ticket with stale blockedBy", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", blockedBy: ["T-999"], phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "blockedBy")).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!).toEqual({ id: "T-001", type: "ticket", set: { blockedBy: [] }, unset: [] });
  });

  it("fixes ticket with stale parentTicket", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", parentTicket: "T-999", phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "parentTicket")).toBe(true);
  });

  it("fixes ticket with stale phase", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "nonexistent" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "phase")).toBe(true);
  });

  it("refuses when load has integrity warnings", () => {
    const state = makeState({ roadmap });
    const result = computeRepairs(state, [
      { file: "T-001.json", message: "Invalid JSON", type: "parse_error" },
    ]);
    expect(result.error).toBeTruthy();
    expect(result.fixes).toHaveLength(0);
  });

  it("refuses on schema_error warnings too", () => {
    const state = makeState({ roadmap });
    const result = computeRepairs(state, [
      { file: "T-002.json", message: "Missing field", type: "schema_error" },
    ]);
    expect(result.error).toBeTruthy();
  });

  it("handles multiple fixes across tickets and issues", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", blockedBy: ["T-888"], phase: "gone" }),
        makeTicket({ id: "T-002", parentTicket: "T-777", phase: "p1" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", relatedTickets: ["T-666"], phase: "also-gone" }),
      ],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.length).toBeGreaterThanOrEqual(4);
    expect(result.patches.filter((p) => p.type === "ticket")).toHaveLength(2);
    expect(result.patches.filter((p) => p.type === "issue")).toHaveLength(1);
  });

  describe("ISS-652: strips stale claim state from completed tickets", () => {

    it("strips claimedBySession from a completed ticket (UUID)", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", status: "complete", phase: "p1", claimedBySession: "sess-abc" })],
        roadmap,
      });
      const result = computeRepairs(state, []);
      expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "claim")).toBe(true);
      const patch = result.patches.find((p) => p.id === "T-001")!;
      expect(patch).toBeDefined();
      expect(patch.unset).toEqual(["claim", "claimedBySession"]);
      expect(patch.set).toEqual({});
    });

    it("strips an explicit-null claimedBySession from a completed ticket", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", status: "complete", phase: "p1", claimedBySession: null })],
        roadmap,
      });
      const result = computeRepairs(state, []);
      expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "claim")).toBe(true);
      const patch = result.patches.find((p) => p.id === "T-001")!;
      expect(patch.unset).toContain("claimedBySession");
      expect(patch.set).toEqual({});
    });

    it("strips a residual claim object from a completed ticket", () => {
      const state = makeState({
        tickets: [makeTicket({
          id: "T-001",
          status: "complete",
          phase: "p1",
          claim: { user: "alice", branch: "feature/x", since: "2026-05-01" },
        })],
        roadmap,
      });
      const result = computeRepairs(state, []);
      expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "claim")).toBe(true);
      const patch = result.patches.find((p) => p.id === "T-001")!;
      expect(patch.unset).toContain("claim");
      expect(patch.set).toEqual({});
    });

    it("leaves an OPEN ticket's claim state untouched", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", status: "open", phase: "p1", claimedBySession: "sess-live" })],
        roadmap,
      });
      const result = computeRepairs(state, []);
      expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "claim")).toBe(false);
      expect(result.patches).toHaveLength(0);
    });

    it("does not flag a clean completed ticket with no claim fields", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", status: "complete", phase: "p1" })],
        roadmap,
      });
      const result = computeRepairs(state, []);
      expect(result.fixes.some((f) => f.field === "claim")).toBe(false);
      expect(result.patches).toHaveLength(0);
    });
  });
});

describe("ISS-738: canonicalize-refs patch emission", () => {
  const phase = makePhase({ id: "p1" });
  const roadmap = makeRoadmap([phase]);

  it("emits canonical ids as plain strings in set, nothing else", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "t-0123456789abcdeg", displayId: "T-100", phase: "p1" }),
        makeTicket({ id: "T-001", blockedBy: ["T-100"], parentTicket: "T-100", phase: "p1" }),
      ],
      roadmap,
    });
    const result = computeRepairs(state, [], { canonicalizeRefs: true });
    const patch = result.patches.find((p) => p.id === "T-001")!;
    expect(patch).toBeDefined();
    expect(patch.set).toEqual({ blockedBy: ["t-0123456789abcdeg"], parentTicket: "t-0123456789abcdeg" });
    expect(patch.unset).toEqual([]);
  });
});
