import { describe, it, expect, afterEach } from "vitest";
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

describe("ISS-758: --field without --use or --value", () => {
  it("throws and leaves the entity untouched", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", title: "body-title" }), [
      fieldConflict("/title", "old", "ours-title", "theirs-title"),
    ]);
    expect(() => resolveConflicts(entity, { field: "title" })).toThrow(/--value/);
    expect(entity.title).toBe("body-title");
    expect((entity._conflicts as ConflictEntry[]).length).toBe(1);
  });
});

describe("entity-level (_entity) resolution (ISS-746)", () => {
  const baseSnap = { id: "T-001", title: "Original", description: "d", type: "task", status: "open", phase: "p1", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null };
  const tombstoneSnap = { ...baseSnap, lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com" };
  const editedSnap = { ...baseSnap, description: "edited by teammate" };

  const entityLevelEntry = (): ConflictEntry => ({
    fieldPath: "",
    field: "_entity",
    kind: "delete-edit",
    base: baseSnap,
    ours: tombstoneSnap,
    theirs: editedSnap,
  });

  it("--use theirs restores the full edit with no junk _entity key", () => {
    // Body is the edited side (new driver behavior); resolving theirs keeps it byte-for-byte.
    const entity = { ...editedSnap, _conflicts: [entityLevelEntry()] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.description).toBe("edited by teammate");
    expect(entity.lifecycle).toBeUndefined();
    expect("_entity" in entity).toBe(false);
    expect(entity._conflicts).toBeUndefined();
  });

  it("--use ours applies the real tombstone with original stamps", () => {
    const entity = { ...editedSnap, _conflicts: [entityLevelEntry()] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { use: "ours" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.lifecycle).toBe("deleted");
    expect(entity.deletedAt).toBe("2026-05-26T00:00:00Z");
    expect(entity.deletedBy).toBe("alice@test.com");
    expect("_entity" in entity).toBe(false);
  });

  it("--field _entity removes only that entry", () => {
    const other = fieldConflict("/phase", "p1", "p2", "p3");
    const entity = { ...editedSnap, _conflicts: [entityLevelEntry(), other] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { field: "_entity", use: "theirs" });
    expect(result.remaining).toBe(1);
    expect((entity._conflicts as ConflictEntry[])[0]!.fieldPath).toBe("/phase");
  });

  it("blanket --use applies entity-level first, then field-level onto the replaced body", () => {
    const other = fieldConflict("/phase", "p1", "p2-ours", "p3-theirs");
    const entity = { ...editedSnap, _conflicts: [other, entityLevelEntry()] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.description).toBe("edited by teammate");
    expect(entity.phase).toBe("p3-theirs");
  });

  it("--value with a full entity object performs wholesale replacement", () => {
    const custom = { ...baseSnap, title: "Hand merged" };
    const entity = { ...editedSnap, _conflicts: [entityLevelEntry()] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { field: "_entity", value: custom });
    expect(result.fullyResolved).toBe(true);
    expect(entity.title).toBe("Hand merged");
    expect("_entity" in entity).toBe(false);
  });

  it("--value with a mismatched id errors", () => {
    const custom = { ...baseSnap, id: "T-999" };
    const entity = { ...editedSnap, _conflicts: [entityLevelEntry()] } as Record<string, unknown>;
    expect(() => resolveConflicts(entity, { field: "_entity", value: custom })).toThrow(/id/);
  });

  it("R3: a null chosen side fails loudly naming --value, without clobbering the body", () => {
    const entry: ConflictEntry = { fieldPath: "", field: "_entity", kind: "delete-edit", base: null, ours: null, theirs: editedSnap };
    const entity = { ...editedSnap, _conflicts: [entry] } as Record<string, unknown>;
    expect(() => resolveConflicts(entity, { use: "ours" })).toThrow(/--value/);
    expect(entity.title).toBe("Original");
    expect(Array.isArray(entity._conflicts)).toBe(true);
  });
});

describe("ISS-801: top-level reserved snapshot keys never survive entity resolution", () => {
  const tombstoneSnap = { id: "T-001", title: "Original", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com" };

  const craftedEntity = (): Record<string, unknown> => JSON.parse(
    '{"id":"T-001","title":"x","constructor":{"polluted":true},"prototype":1,"__proto__":{"polluted":true}}',
  ) as Record<string, unknown>;

  const entityLevelEntry = (theirs: unknown): ConflictEntry => ({
    fieldPath: "",
    field: "_entity",
    kind: "delete-edit",
    base: null,
    ours: tombstoneSnap,
    theirs,
  } as ConflictEntry);

  afterEach(() => {
    // Pollution hygiene: RED recordings on unfixed code could write onto the
    // prototypes; scrub the probe key so parallel vitest workers stay clean.
    delete (Object.prototype as Record<string, unknown>)["polluted"];
  });

  it("entity-level --use theirs strips top-level reserved keys from the applied snapshot", () => {
    const crafted = craftedEntity();
    const entity = { id: "T-001", title: "Original", _conflicts: [entityLevelEntry(crafted)] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(Object.hasOwn(entity, "constructor")).toBe(false);
    expect(Object.hasOwn(entity, "prototype")).toBe(false);
    expect(Object.hasOwn(entity, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(entity)).toBe(Object.prototype);
    expect(entity.id).toBe("T-001");
    expect(entity.title).toBe("x");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("entity-level --field _entity --value strips top-level reserved keys from the custom value", () => {
    const crafted = craftedEntity();
    const entity = { id: "T-001", title: "Original", _conflicts: [entityLevelEntry(craftedEntity())] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { field: "_entity", value: crafted });
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toContain("_entity");
    expect(Object.hasOwn(entity, "constructor")).toBe(false);
    expect(Object.hasOwn(entity, "prototype")).toBe(false);
    expect(Object.hasOwn(entity, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(entity)).toBe(Object.prototype);
    expect(entity.title).toBe("x");
    expect(entity._conflicts).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("field-level blanket --use never writes reserved-name conflicts but still consumes them", () => {
    const entity = withConflicts(makeTicket({ id: "T-001" }), [
      fieldConflict("/constructor", null, null, JSON.parse('{"polluted":true}')),
      fieldConflict("/prototype", null, null, 1),
    ]);
    const result = resolveConflicts(entity, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toContain("constructor");
    expect(result.resolved).toContain("prototype");
    expect(Object.hasOwn(entity, "constructor")).toBe(false);
    expect(Object.hasOwn(entity, "prototype")).toBe(false);
    expect(entity._conflicts).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("single --field targeting a reserved name consumes the conflict without writing the key", () => {
    const entity = withConflicts(makeTicket({ id: "T-001" }), [
      fieldConflict("/constructor", null, null, JSON.parse('{"polluted":true}')),
    ]);
    const result = resolveConflicts(entity, { field: "constructor", use: "theirs" });
    expect(result.resolved).toEqual(["constructor"]);
    expect(Object.hasOwn(entity, "constructor")).toBe(false);
    expect(entity._conflicts).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("coupled group applies legit members and skips reserved-name members", () => {
    const entity = withConflicts(makeTicket({ id: "T-001", status: "open" }), [
      fieldConflict("/constructor", null, null, JSON.parse('{"polluted":true}'), { kind: "coupled", group: "g1" }),
      fieldConflict("/status", "open", "inprogress", "complete", { kind: "coupled", group: "g1" }),
    ]);
    const result = resolveConflicts(entity, { field: "status", use: "theirs" });
    expect(entity.status).toBe("complete");
    expect(Object.hasOwn(entity, "constructor")).toBe(false);
    expect(result.resolved).toContain("constructor");
    expect(result.resolved).toContain("status");
    expect(result.fullyResolved).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("legacy placeholder _entity entries (pre-1.5.0)", () => {
  const legacyEntry = (): ConflictEntry => ({
    fieldPath: "",
    field: "_entity",
    kind: "delete-edit",
    base: "active",
    ours: "deleted",
    theirs: "edited",
  });

  it("choosing the delete side synthesizes a tombstone with actor attribution and a warning", () => {
    const entity = { ...makeTicket({ id: "T-001" }), _conflicts: [legacyEntry()] } as Record<string, unknown>;
    const result = resolveConflicts(entity, { use: "ours", actor: "carol@test.com" });
    expect(result.fullyResolved).toBe(true);
    expect(entity.lifecycle).toBe("deleted");
    expect(typeof entity.deletedAt).toBe("string");
    expect(entity.deletedBy).toBe("carol@test.com");
    expect("_entity" in entity).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("choosing the edit side throws with git-recovery and --value guidance, keeping the entry", () => {
    const entity = { ...makeTicket({ id: "T-001" }), _conflicts: [legacyEntry()] } as Record<string, unknown>;
    expect(() => resolveConflicts(entity, { use: "theirs" })).toThrow(/git log --all/);
    expect(() => resolveConflicts(entity, { use: "theirs" })).toThrow(/--value/);
    expect(Array.isArray(entity._conflicts)).toBe(true);
    expect((entity._conflicts as ConflictEntry[]).length).toBe(1);
    expect("_entity" in entity).toBe(false);
  });
});
