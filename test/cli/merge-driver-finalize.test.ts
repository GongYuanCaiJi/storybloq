import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMergeDriver, finalizeMergeOutput, schemaFor, type MergeStrategy } from "../../src/cli/commands/merge-driver.js";
import type { MergeResult } from "../../src/core/merge-driver.js";
import { TicketSchema } from "../../src/models/ticket.js";
import { ConfigSchema } from "../../src/models/config.js";
import { RoadmapSchema } from "../../src/models/roadmap.js";

const ticketStrategy: MergeStrategy = { kind: "entity", entityType: "ticket" };

function validTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-001", title: "Test", description: "", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2026-01-01",
    blockedBy: [], parentTicket: null, completedDate: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schemaFor", () => {
  it("maps strategies to the exact loader schemas", () => {
    expect(schemaFor(ticketStrategy)).toBe(TicketSchema);
    expect(schemaFor({ kind: "config" })).toBe(ConfigSchema);
    expect(schemaFor({ kind: "roadmap" })).toBe(RoadmapSchema);
  });
});

describe("finalizeMergeOutput", () => {
  it("passes a valid merged output through unchanged with the normal exit code", () => {
    const base = validTicket();
    const ours = validTicket({ title: "Ours" });
    const theirs = validTicket({ title: "Theirs" });
    const result: MergeResult = { merged: validTicket({ title: "Ours" }), conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, ours, theirs, result);
    expect("hardError" in final).toBe(false);
    if (!("hardError" in final)) {
      expect(final.exit).toBe(0);
      expect(final.merged.title).toBe("Ours");
    }
  });

  it("invalid merged output with valid ours falls back to the ours body + full-snapshot entry, exit 1", () => {
    const base = validTicket();
    const ours = validTicket({ title: "Ours" });
    const theirs = validTicket({ title: "Theirs" });
    const result: MergeResult = { merged: { garbage: true }, conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, ours, theirs, result);
    expect("hardError" in final).toBe(false);
    if (!("hardError" in final)) {
      expect(final.exit).toBe(1);
      expect(final.merged.title).toBe("Ours");
      expect(TicketSchema.safeParse(final.merged).success).toBe(true);
      const entries = final.merged._conflicts as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.field).toBe("_entity");
      expect(entries[0]!.kind).toBe("field");
      expect((entries[0]!.base as Record<string, unknown>).id).toBe("T-001");
      expect((entries[0]!.ours as Record<string, unknown>).title).toBe("Ours");
      expect((entries[0]!.theirs as Record<string, unknown>).title).toBe("Theirs");
    }
  });

  it("invalid ours + valid theirs falls back to the theirs body, exit 1", () => {
    const base = validTicket();
    const ours = { id: "T-001" }; // invalid: missing required fields
    const theirs = validTicket({ title: "Theirs" });
    const result: MergeResult = { merged: { garbage: true }, conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, ours, theirs, result);
    expect("hardError" in final).toBe(false);
    if (!("hardError" in final)) {
      expect(final.exit).toBe(1);
      expect(final.merged.title).toBe("Theirs");
      expect(TicketSchema.safeParse(final.merged).success).toBe(true);
    }
  });

  it("both candidates invalid returns hardError", () => {
    const base = {};
    const ours = { a: 1 };
    const theirs = { b: 2 };
    const result: MergeResult = { merged: { a: 1, b: 2 }, conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, ours, theirs, result);
    expect("hardError" in final).toBe(true);
  });

  it("pass-through exemption: merged content deep-equal to invalid ours is written as-is", () => {
    const invalid = { id: "T-001", junk: true }; // fails TicketSchema
    const base = { id: "T-001" };
    const theirs = { id: "T-001", junk: true };
    const result: MergeResult = { merged: { id: "T-001", junk: true }, conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, invalid, theirs, result);
    expect("hardError" in final).toBe(false);
    if (!("hardError" in final)) {
      expect(final.exit).toBe(0);
      expect(final.merged).toEqual({ id: "T-001", junk: true });
    }
  });

  it("filters malformed carried entries from the fallback candidate with a stderr note", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const malformed = { fieldPath: "/x", ours: 1 }; // missing kind -> fails ConflictEntrySchema
    const wellFormed = { fieldPath: "/phase", field: "phase", kind: "field", base: "p1", ours: "p2", theirs: "p3" };
    const base = validTicket();
    const ours = validTicket({ title: "Ours", _conflicts: [malformed, wellFormed] });
    const theirs = validTicket({ title: "Theirs", _conflicts: [malformed, wellFormed] });
    const result: MergeResult = { merged: { garbage: true }, conflicts: [], clean: true };
    const final = finalizeMergeOutput(ticketStrategy, base, ours, theirs, result);
    expect("hardError" in final).toBe(false);
    if (!("hardError" in final)) {
      const entries = final.merged._conflicts as Array<Record<string, unknown>>;
      expect(entries.some((e) => e.fieldPath === "/phase")).toBe(true);
      expect(entries.some((e) => e.fieldPath === "/x")).toBe(false);
      expect(TicketSchema.safeParse(final.merged).success).toBe(true);
    }
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe("handleMergeDriver output gate", () => {
  function writeTemp(dir: string, name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content, "utf-8");
    return p;
  }

  it("writes NOTHING and exits 2 when both sides are schema-broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
    const base = writeTemp(dir, "base.json", "");
    const oursOriginal = JSON.stringify({ a: 1 }, null, 2) + "\n";
    const ours = writeTemp(dir, "ours.json", oursOriginal);
    const theirs = writeTemp(dir, "theirs.json", JSON.stringify({ b: 2 }, null, 2) + "\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json");
    expect(exit).toBe(2);
    expect(readFileSync(ours, "utf-8")).toBe(oursOriginal);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("add/add divergent title stays loadable through the real driver entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
    const base = writeTemp(dir, "base.json", "");
    const ours = writeTemp(dir, "ours.json", JSON.stringify(validTicket({ title: "From A" }), null, 2) + "\n");
    const theirs = writeTemp(dir, "theirs.json", JSON.stringify(validTicket({ title: "From B" }), null, 2) + "\n");
    const exit = handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json");
    expect(exit).toBe(1);
    const merged = JSON.parse(readFileSync(ours, "utf-8"));
    expect(TicketSchema.safeParse(merged).success).toBe(true);
    expect(merged.title).toBe("From A");
  });
});
