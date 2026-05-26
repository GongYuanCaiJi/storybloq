import { describe, it, expect } from "vitest";
import { resolveConflicts } from "../../src/core/resolve.js";
import { makeTicket } from "./test-factories.js";
import type { ConflictEntry } from "../../src/models/types.js";

function withConflicts(ticket: ReturnType<typeof makeTicket>, conflicts: ConflictEntry[]) {
  const t = { ...ticket } as Record<string, unknown>;
  t._conflicts = conflicts;
  return t;
}

const fieldConflict = (fieldPath: string, base: unknown, ours: unknown, theirs: unknown, extra?: Partial<ConflictEntry>): ConflictEntry => ({
  fieldPath,
  kind: "field",
  base,
  ours,
  theirs,
  ...extra,
});

describe("resolveConflicts", () => {
  it("--use ours resolves all conflicts", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete"),
      fieldConflict("title", "old", "ours-title", "theirs-title"),
    ]);
    const result = resolveConflicts(entity, { use: "ours" });
    expect(result.fullyResolved).toBe(true);
    expect(result.remaining).toBe(0);
    expect(entity.status).toBe("inprogress");
    expect(entity.title).toBe("ours-title");
    expect(entity._conflicts).toBeUndefined();
  });

  it("--use theirs resolves all conflicts", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete"),
    ]);
    const result = resolveConflicts(entity, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.status).toBe("complete");
    expect(entity._conflicts).toBeUndefined();
  });

  it("--field + --use resolves single field", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete"),
      fieldConflict("title", "old", "ours-title", "theirs-title"),
    ]);
    const result = resolveConflicts(entity, { field: "status", use: "ours" });
    expect(result.resolved).toEqual(["status"]);
    expect(result.remaining).toBe(1);
    expect(result.fullyResolved).toBe(false);
    expect(entity.status).toBe("inprogress");
    expect((entity._conflicts as ConflictEntry[]).length).toBe(1);
  });

  it("--field + --use on coupled group resolves all in group", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete", { kind: "coupled", group: "status-phase" }),
      fieldConflict("phase", "p1", "p2", "p3", { kind: "coupled", group: "status-phase" }),
      fieldConflict("title", "old", "ours-title", "theirs-title"),
    ]);
    const result = resolveConflicts(entity, { field: "status", use: "theirs" });
    expect(result.resolved.sort()).toEqual(["phase", "status"]);
    expect(result.remaining).toBe(1);
    expect(entity.status).toBe("complete");
    expect(entity.phase).toBe("p3");
  });

  it("--field + --value sets custom value (non-coupled)", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("title", "old", "ours-title", "theirs-title"),
    ]);
    const result = resolveConflicts(entity, { field: "title", value: "custom-title" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.title).toBe("custom-title");
    expect(entity._conflicts).toBeUndefined();
  });

  it("rejects --value on coupled group field", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete", { kind: "coupled", group: "g1" }),
      fieldConflict("phase", "p1", "p2", "p3", { kind: "coupled", group: "g1" }),
    ]);
    expect(() => resolveConflicts(entity, { field: "status", value: "complete" })).toThrow("coupled");
  });

  it("removes _conflicts key when fully resolved", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete"),
    ]);
    resolveConflicts(entity, { use: "ours" });
    expect("_conflicts" in entity).toBe(false);
  });

  it("returns remaining count", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("status", "open", "inprogress", "complete"),
      fieldConflict("title", "old", "a", "b"),
      fieldConflict("description", "old", "a", "b"),
    ]);
    const result = resolveConflicts(entity, { field: "status", use: "ours" });
    expect(result.remaining).toBe(2);
    expect(result.resolved).toEqual(["status"]);
  });
});
