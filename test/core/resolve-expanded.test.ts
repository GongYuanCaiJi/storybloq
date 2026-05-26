import { describe, it, expect } from "vitest";
import { resolveConflicts } from "../../src/core/resolve.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";

describe("T-386: expanded _conflicts metadata", () => {
  describe("merge driver emits JSON Pointer fieldPath + field alias", () => {
    it("hard conflict has /fieldName fieldPath and field alias", () => {
      const base = { id: "T-001", title: "Original", status: "open", type: "task", phase: "p1", order: 10, createdDate: "2026-01-01", blockedBy: [], parentTicket: null, completedDate: null, description: "" };
      const ours = { ...base, title: "Ours" };
      const theirs = { ...base, title: "Theirs" };
      const result = threeWayMerge(base, ours, theirs, "ticket");
      const titleConflict = result.conflicts.find((c) => c.fieldPath === "/title" || (c as Record<string, unknown>).field === "title");
      expect(titleConflict).toBeDefined();
      expect(titleConflict!.fieldPath).toBe("/title");
      expect((titleConflict as Record<string, unknown>).field).toBe("title");
    });

    it("coupled conflict has /fieldName fieldPath", () => {
      const base = { id: "T-001", title: "T", status: "open", type: "task", phase: "p1", order: 10, createdDate: "2026-01-01", blockedBy: [], parentTicket: null, completedDate: null, description: "", lifecycle: "active" };
      const ours = { ...base, status: "inprogress" };
      const theirs = { ...base, status: "complete", completedDate: "2026-05-26" };
      const result = threeWayMerge(base, ours, theirs, "ticket");
      const statusConflict = result.conflicts.find((c) => c.fieldPath === "/status");
      expect(statusConflict).toBeDefined();
      expect(statusConflict!.kind).toBe("coupled");
      expect((statusConflict as Record<string, unknown>).field).toBe("status");
    });
  });

  describe("resolve accepts both plain name and JSON Pointer", () => {
    it("resolves by plain field name against /fieldPath conflict", () => {
      const entity: Record<string, unknown> = {
        id: "T-001",
        title: "base",
        _conflicts: [
          { fieldPath: "/title", field: "title", kind: "field", base: "base", ours: "A", theirs: "B" },
        ],
      };
      const result = resolveConflicts(entity, { field: "title", use: "ours" });
      expect(result.resolved).toContain("title");
      expect(entity.title).toBe("A");
      expect(entity._conflicts).toBeUndefined();
    });

    it("resolves by JSON Pointer against /fieldPath conflict", () => {
      const entity: Record<string, unknown> = {
        id: "T-001",
        title: "base",
        _conflicts: [
          { fieldPath: "/title", field: "title", kind: "field", base: "base", ours: "A", theirs: "B" },
        ],
      };
      const result = resolveConflicts(entity, { field: "/title", use: "theirs" });
      expect(result.resolved.length).toBe(1);
      expect(entity.title).toBe("B");
    });
  });

  describe("coupled group resolution with JSON Pointer", () => {
    it("resolves all coupled members when one is targeted", () => {
      const entity: Record<string, unknown> = {
        id: "T-001",
        status: "open",
        completedDate: null,
        lifecycle: "active",
        _conflicts: [
          { fieldPath: "/status", field: "status", kind: "coupled", group: "ticket-status", base: "open", ours: "inprogress", theirs: "complete" },
          { fieldPath: "/completedDate", field: "completedDate", kind: "coupled", group: "ticket-status", base: null, ours: null, theirs: "2026-05-26" },
          { fieldPath: "/lifecycle", field: "lifecycle", kind: "coupled", group: "ticket-status", base: "active", ours: "active", theirs: "active" },
        ],
      };
      const result = resolveConflicts(entity, { field: "status", use: "theirs" });
      expect(result.resolved).toContain("status");
      expect(result.resolved).toContain("completedDate");
      expect(result.resolved).toContain("lifecycle");
      expect(entity.status).toBe("complete");
      expect(entity.completedDate).toBe("2026-05-26");
    });

    it("refuses partial resolution of coupled group with --value", () => {
      const entity: Record<string, unknown> = {
        id: "T-001",
        status: "open",
        _conflicts: [
          { fieldPath: "/status", field: "status", kind: "coupled", group: "ticket-status", base: "open", ours: "inprogress", theirs: "complete" },
        ],
      };
      expect(() => resolveConflicts(entity, { field: "status", value: "complete" })).toThrow();
    });
  });
});
