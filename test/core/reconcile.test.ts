import { describe, it, expect } from "vitest";
import { computeReconcilePlan } from "../../src/core/reconcile.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase } from "./test-factories.js";

const state = (opts: Parameters<typeof makeState>[0]) =>
  makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]), ...opts });

describe("computeReconcilePlan", () => {
  it("returns empty plan when no duplicates exist", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-002", createdDate: "2026-01-02" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(0);
    expect(result.plan.warnings).toHaveLength(0);
  });

  it("older createdDate wins when two tickets share a displayId", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    const rename = result.plan.renames[0]!;
    expect(rename.id).toBe("t-bbb0000000000002");
    expect(rename.oldDisplayId).toBe("T-042");
    expect(rename.newDisplayId).toMatch(/^T-\d{3,}$/);
    expect(rename.entityType).toBe("ticket");
  });

  it("lower canonical id wins when timestamps are equal", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-zzz0000000000099", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-zzz0000000000099");
  });

  it("legacy item wins over canonical item with same displayId", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "T-042", createdDate: "2026-03-01" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
  });

  it("legacy item with matching effectiveDisplayId wins over suffixed legacy item", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "T-042", displayId: "T-042", createdDate: "2026-03-01" }),
        makeTicket({ id: "T-042a", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("T-042a");
  });

  it("resolves each entity type independently", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-001", createdDate: "2026-01-15" }),
      ],
      issues: [
        makeIssue({ id: "i-aaa0000000000001", displayId: "ISS-001", discoveredDate: "2026-01-01" }),
        makeIssue({ id: "i-bbb0000000000002", displayId: "ISS-001", discoveredDate: "2026-02-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(2);
    const ticketRename = result.plan.renames.find((r) => r.entityType === "ticket");
    const issueRename = result.plan.renames.find((r) => r.entityType === "issue");
    expect(ticketRename).toBeDefined();
    expect(issueRename).toBeDefined();
    expect(ticketRename!.id).toBe("t-bbb0000000000002");
    expect(issueRename!.id).toBe("i-bbb0000000000002");
  });

  it("refuses when any entity has non-empty _conflicts", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", _conflicts: [{ field: "title", ours: "A", theirs: "B" }] } as any),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("conflict");
  });

  it("allocates new displayId using maxSequentialNumber + 1", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-050", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-050", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", displayId: "T-100", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.newDisplayId).toBe("T-101");
  });

  it("renumbers multiple losers in a three-way duplicate", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", displayId: "T-042", createdDate: "2026-01-20" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(2);
    const newIds = result.plan.renames.map((r) => r.newDisplayId);
    expect(new Set(newIds).size).toBe(2);
  });

  it("produces empty plan when run on already-reconciled state (idempotent)", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-043", createdDate: "2026-01-15" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(0);
  });

  it("item with valid timestamp wins over item with missing timestamp", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-06-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
  });

  it("falls back to canonical id when both timestamps are missing", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-zzz0000000000099", displayId: "T-042", createdDate: "" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-zzz0000000000099");
  });
});
