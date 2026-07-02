import { describe, it, expect } from "vitest";
import { resolveDocConflicts } from "../../src/core/resolve-doc.js";

type Entry = Record<string, unknown>;

function withConflicts(doc: Record<string, unknown>, conflicts: Entry[]): Record<string, unknown> {
  return { ...doc, _conflicts: conflicts };
}

const phase = (id: string, name = id.toUpperCase()): Record<string, unknown> => ({
  id, label: id.toUpperCase(), name, description: `${id} desc`,
});

describe("resolveDocConflicts: pointer entries", () => {
  it("sets a nested pointer (/team/enabled targets config.team.enabled, not top-level enabled)", () => {
    const doc = withConflicts(
      { version: 2, project: "p", team: { enabled: false } },
      [{ fieldPath: "/team/enabled", field: "enabled", kind: "field", base: false, ours: true, theirs: false }],
    );
    const result = resolveDocConflicts(doc, { use: "ours" });
    expect(result.fullyResolved).toBe(true);
    expect((doc.team as Record<string, unknown>).enabled).toBe(true);
    expect(doc.enabled).toBeUndefined();
    expect(doc._conflicts).toBeUndefined();
  });

  it("deletes an object key when the chosen side is undefined", () => {
    const doc = withConflicts(
      { version: 2, customKey: "x" },
      [{ fieldPath: "/customKey", field: "customKey", kind: "delete-edit", base: "x", ours: undefined, theirs: "y" }],
    );
    resolveDocConflicts(doc, { use: "ours" });
    expect("customKey" in doc).toBe(false);
  });

  it("treats a legacy bare fieldPath as a single top-level segment", () => {
    const doc = withConflicts(
      { version: 2, project: "old" },
      [{ fieldPath: "project", kind: "field", base: "old", ours: "mine", theirs: "yours" }],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(doc.project).toBe("yours");
  });

  it("applies bulk pointer-index deletions in descending index order", () => {
    const doc = withConflicts(
      { items: ["x", "y", "z"] },
      [
        { fieldPath: "/items/0", field: "items", kind: "delete-edit", base: "x", ours: undefined, theirs: "x2" },
        { fieldPath: "/items/2", field: "items", kind: "delete-edit", base: "z", ours: undefined, theirs: "z2" },
      ],
    );
    const result = resolveDocConflicts(doc, { use: "ours" });
    expect(result.fullyResolved).toBe(true);
    expect(doc.items).toEqual(["y"]);
  });

  it("errors loudly (naming the pointer and --value) on a missing container", () => {
    const doc = withConflicts(
      { version: 2 },
      [{ fieldPath: "/nope/deep", field: "deep", kind: "field", base: 1, ours: 2, theirs: 3 }],
    );
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/\/nope\/deep/);
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/--value/);
  });
});

describe("resolveDocConflicts: keyed-element entries", () => {
  it("replaces an element located by key even when the recorded index has drifted", () => {
    const doc = withConflicts(
      { phases: [phase("p0"), phase("p2")] },
      [{
        fieldPath: "/phases/5",
        field: "phases[id=p2]",
        kind: "array-element",
        base: undefined,
        ours: phase("p2", "Ours"),
        theirs: phase("p2", "Theirs"),
      }],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases).toHaveLength(2);
    expect(phases[1]!.name).toBe("Theirs");
  });

  it("removes an element by key when the chosen delete-edit side is undefined", () => {
    const doc = withConflicts(
      { phases: [phase("p0"), phase("p2"), phase("p3")] },
      [{
        fieldPath: "/phases/1",
        field: "phases[id=p2]",
        kind: "delete-edit",
        base: phase("p2"),
        ours: undefined,
        theirs: phase("p2", "Edited"),
      }],
    );
    resolveDocConflicts(doc, { use: "ours" });
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["p0", "p3"]);
  });

  it("restores a missing element at the recorded index (clamped) when choosing the edited side", () => {
    const doc = withConflicts(
      { phases: [phase("p0"), phase("p3")] },
      [{
        fieldPath: "/phases/1",
        field: "phases[id=p2]",
        kind: "delete-edit",
        base: phase("p2"),
        ours: undefined,
        theirs: phase("p2", "Edited"),
      }],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["p0", "p2", "p3"]);
    expect(phases[1]!.name).toBe("Edited");
  });
});

describe("resolveDocConflicts: reorder entries", () => {
  const reorderEntry = (): Entry => ({
    fieldPath: "/phases",
    field: "phases",
    kind: "field",
    base: ["a", "b", "c"],
    ours: ["c", "a", "b"],
    theirs: ["b", "c", "a"],
  });

  it("reorders EXISTING merged elements to the chosen side's id order, preserving content", () => {
    const merged = [
      { ...phase("a"), description: "a desc MERGED-EDIT" },
      phase("b"),
      phase("c"),
    ];
    const doc = withConflicts({ phases: merged }, [reorderEntry()]);
    const result = resolveDocConflicts(doc, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(phases[2]!.description).toBe("a desc MERGED-EDIT");
  });

  it("appends doc-only elements at the end and skips ids missing from the doc", () => {
    const doc = withConflicts(
      { phases: [phase("a"), phase("b"), phase("x")] },
      [{
        fieldPath: "/phases", field: "phases", kind: "field",
        base: ["a", "b"], ours: ["a", "b"], theirs: ["b", "zz", "a"],
      }],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["b", "a", "x"]);
  });

  it("accepts --value as an id-string array", () => {
    const doc = withConflicts({ phases: [phase("a"), phase("b"), phase("c")] }, [reorderEntry()]);
    resolveDocConflicts(doc, { field: "phases", value: ["b", "a", "c"] });
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});

describe("resolveDocConflicts: entity-level and guards", () => {
  it("applies wholesale document replacement for an entity-level entry", () => {
    const oursDoc = { version: 2, project: "ours-project", type: "npm", language: "ts" };
    const theirsDoc = { version: 2, project: "theirs-project", type: "npm", language: "ts" };
    const doc = withConflicts(
      { version: 2, project: "damaged" },
      [{ fieldPath: "", field: "_entity", kind: "field", base: null, ours: oursDoc, theirs: theirsDoc }],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(doc.project).toBe("theirs-project");
    expect(doc._conflicts).toBeUndefined();
  });

  it("ISS-758 guard: --field without --use or --value throws", () => {
    const doc = withConflicts(
      { version: 2, project: "p" },
      [{ fieldPath: "/project", field: "project", kind: "field", base: "a", ours: "b", theirs: "c" }],
    );
    expect(() => resolveDocConflicts(doc, { field: "project" })).toThrow(/--value/);
    expect(doc.project).toBe("p");
  });
});
