import { describe, it, expect, afterEach } from "vitest";
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

describe("ISS-768: reserved pointer segments are refused", () => {
  afterEach(() => {
    // Pollution hygiene: RED recordings on unfixed code write onto the
    // prototypes; scrub every probe key so vitest workers stay clean.
    delete (Object.prototype as Record<string, unknown>)["polluted"];
    delete (Object.prototype as Record<string, unknown>)["x"];
    delete (Function.prototype as unknown as Record<string, unknown>)["x"];
  });

  it("refuses a /__proto__/ set and leaves Object.prototype clean", () => {
    const doc = withConflicts(
      { version: 2, project: "p" },
      [{ fieldPath: "/__proto__/polluted", field: "polluted", kind: "field", base: null, ours: null, theirs: "owned" }],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/reserved prototype key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(doc, "polluted")).toBe(false);
  });

  it("refuses a nested /a/constructor/prototype/x set and leaves prototypes clean", () => {
    const doc = withConflicts(
      { version: 2, a: {} },
      [{ fieldPath: "/a/constructor/prototype/x", field: "x", kind: "field", base: null, ours: null, theirs: "owned" }],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/reserved prototype key/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).x).toBeUndefined();
  });

  it("refuses a legacy bare __proto__ fieldPath", () => {
    const doc = withConflicts(
      { version: 2 },
      [{ fieldPath: "__proto__", field: "__proto__", kind: "field", base: null, ours: null, theirs: { polluted: "owned" } }],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/reserved prototype key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a delete path ending in __proto__", () => {
    const doc = withConflicts(
      { version: 2, x: {} },
      [{ fieldPath: "/x/__proto__", field: "__proto__", kind: "delete-edit", base: "a", ours: undefined, theirs: "b" }],
    );
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/reserved prototype key/);
  });

  it("does not over-block benign fields containing the substrings", () => {
    const doc = withConflicts(
      { version: 2, prototypeSettings: { mode: "old" } },
      [{ fieldPath: "/prototypeSettings/mode", field: "mode", kind: "field", base: "old", ours: "new", theirs: "old" }],
    );
    resolveDocConflicts(doc, { use: "ours" });
    expect((doc.prototypeSettings as Record<string, unknown>).mode).toBe("new");
  });

  it("refuses to descend inherited (non-own) mid-walk properties", () => {
    const child = Object.create({ mid: { deep: "inherited" } }) as Record<string, unknown>;
    const doc = withConflicts(
      { version: 2, a: child },
      [{ fieldPath: "/a/mid/deep", field: "deep", kind: "field", base: "x", ours: "y", theirs: "x" }],
    );
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/\/a\/mid\/deep/);
    expect((Object.getPrototypeOf(child) as Record<string, Record<string, unknown>>).mid.deep).toBe("inherited");
  });
});

describe("ISS-769: pointer ops are identity-anchored across reorder/keyed mutation", () => {
  const phaseWith = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...phase(id), ...extra,
  });
  const ids = (doc: Record<string, unknown>): string[] =>
    (doc.phases as Array<Record<string, unknown>>).map((p) => p.id as string);
  const byId = (doc: Record<string, unknown>, id: string): Record<string, unknown> =>
    (doc.phases as Array<Record<string, unknown>>).find((p) => p.id === id)!;

  it("REPRO (g): reorder + nested field lands on the identity-matched element, not the drifted index", () => {
    const doc = withConflicts(
      { title: "t", phases: [phase("p1"), phase("p2"), phase("p3")] },
      [
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2", "p3"], ours: ["p1", "p2", "p3"], theirs: ["p3", "p1", "p2"] },
        { fieldPath: "/phases/1/name", field: "name", kind: "field", base: "P2", ours: "P2", theirs: "renamed-p2" },
      ],
    );
    const result = resolveDocConflicts(doc, { use: "theirs" });
    expect(result.fullyResolved).toBe(true);
    expect(ids(doc)).toEqual(["p3", "p1", "p2"]);
    expect(byId(doc, "p2").name).toBe("renamed-p2");
    expect(byId(doc, "p1").name).toBe("P1");
    expect(byId(doc, "p3").name).toBe("P3");
  });

  it("(h) keyed splice before a pointer-set: the set still lands on the captured element", () => {
    const doc = withConflicts(
      { phases: [phase("p1"), phase("p2"), phase("p3")] },
      [
        { fieldPath: "/phases/0", field: "phases[id=p1]", kind: "delete-edit", base: phase("p1"), ours: phase("p1"), theirs: undefined },
        { fieldPath: "/phases/2/name", field: "name", kind: "field", base: "P3", ours: "P3", theirs: "renamed-p3" },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(ids(doc)).toEqual(["p2", "p3"]);
    expect(byId(doc, "p3").name).toBe("renamed-p3");
    expect(byId(doc, "p2").name).toBe("P2");
  });

  it("(i) pointer-delete with reorder removes from the captured element, not the index occupant", () => {
    const doc = withConflicts(
      { phases: [phaseWith("p1", { tempNote: "on-p1" }), phase("p2"), phaseWith("p3", { tempNote: "on-p3" })] },
      [
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2", "p3"], ours: ["p1", "p2", "p3"], theirs: ["p3", "p2", "p1"] },
        { fieldPath: "/phases/0/tempNote", field: "tempNote", kind: "delete-edit", base: "on-p1", ours: "keep", theirs: undefined },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(ids(doc)).toEqual(["p3", "p2", "p1"]);
    expect(Object.hasOwn(byId(doc, "p1"), "tempNote")).toBe(false);
    expect(byId(doc, "p3").tempNote).toBe("on-p3");
  });

  it("(j) whole-element numeric set replaces the captured element across a reorder", () => {
    const replacement = phaseWith("p2", { name: "P2-replaced" });
    const doc = withConflicts(
      { phases: [phase("p1"), phase("p2"), phase("p3")] },
      [
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2", "p3"], ours: ["p1", "p2", "p3"], theirs: ["p2", "p3", "p1"] },
        { fieldPath: "/phases/1", field: "phases", kind: "field", base: phase("p2"), ours: phase("p2"), theirs: replacement },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(ids(doc)).toEqual(["p2", "p3", "p1"]);
    expect((doc.phases as Array<Record<string, unknown>>)[0]).toBe(replacement);
    expect(byId(doc, "p3").name).toBe("P3");
  });

  it("(k) primitive arrays with duplicates apply at the recorded index (regression lock)", () => {
    const setDoc = withConflicts(
      { items: ["x", "x"] },
      [{ fieldPath: "/items/1", field: "items", kind: "field", base: "x", ours: "y", theirs: "x" }],
    );
    resolveDocConflicts(setDoc, { use: "ours" });
    expect(setDoc.items).toEqual(["x", "y"]);

    const delDoc = withConflicts(
      { items: ["x", "x"] },
      [{ fieldPath: "/items/1", field: "items", kind: "delete-edit", base: "x", ours: undefined, theirs: "x" }],
    );
    resolveDocConflicts(delDoc, { use: "ours" });
    expect(delDoc.items).toEqual(["x"]);
  });

  it("(l1) nested pointer under a keyed-replaced ancestor relocates into the replacement", () => {
    const newP2 = phaseWith("p2", { name: "P2R", tasks: [{ id: "t1", title: "replaced-old" }] });
    const doc = withConflicts(
      { phases: [phase("p1"), phaseWith("p2", { tasks: [{ id: "t1", title: "old" }] }), phase("p3")] },
      [
        { fieldPath: "/phases/1", field: "phases[id=p2]", kind: "array-element", base: null, ours: null, theirs: newP2 },
        { fieldPath: "/phases/1/tasks/0/title", field: "title", kind: "field", base: "old", ours: "old", theirs: "new-title" },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(byId(doc, "p2").name).toBe("P2R");
    expect(((byId(doc, "p2").tasks as Array<Record<string, unknown>>)[0]).title).toBe("new-title");
    expect(byId(doc, "p1").name).toBe("P1");
    expect(byId(doc, "p3").name).toBe("P3");
  });

  it("(l2) nested pointer under a keyed-REMOVED ancestor refuses instead of writing elsewhere", () => {
    const doc = withConflicts(
      { phases: [phase("p1"), phaseWith("p2", { tasks: [{ id: "t1", title: "old" }] }), phaseWith("p3", { tasks: [{ id: "t9", title: "p3task" }] })] },
      [
        { fieldPath: "/phases/1", field: "phases[id=p2]", kind: "delete-edit", base: phase("p2"), ours: phase("p2"), theirs: undefined },
        { fieldPath: "/phases/1/tasks/0/title", field: "title", kind: "field", base: "old", ours: "old", theirs: "new-title" },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/phases\/1\/tasks\/0\/title/);
    expect(((byId(doc, "p3").tasks as Array<Record<string, unknown>>)[0]).title).toBe("p3task");
  });

  it("(m) mid-walk pointer-delete through a removed ancestor refuses", () => {
    const doc = withConflicts(
      { phases: [phase("p1"), phaseWith("p2", { tasks: [{ id: "t1" }] }), phaseWith("p3", { tasks: [{ id: "t9" }] })] },
      [
        { fieldPath: "/phases/1", field: "phases[id=p2]", kind: "delete-edit", base: phase("p2"), ours: phase("p2"), theirs: undefined },
        { fieldPath: "/phases/1/tasks/0", field: "tasks", kind: "delete-edit", base: { id: "t1" }, ours: { id: "t1" }, theirs: undefined },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/phases\/1\/tasks\/0/);
    expect((byId(doc, "p3").tasks as unknown[]).length).toBe(1);
  });

  it("(n) relocation works for keyed arrays with arbitrary key fields (slug)", () => {
    const newW2 = { slug: "w2", color: "navy" };
    const doc = withConflicts(
      { widgets: [{ slug: "w1", color: "red" }, { slug: "w2", color: "blue" }] },
      [
        { fieldPath: "/widgets/1", field: "widgets[slug=w2]", kind: "array-element", base: null, ours: null, theirs: newW2 },
        { fieldPath: "/widgets/1/color", field: "color", kind: "field", base: "blue", ours: "blue", theirs: "green" },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    const widgets = doc.widgets as Array<Record<string, unknown>>;
    expect(widgets[1].slug).toBe("w2");
    expect(widgets[1].color).toBe("green");
    expect(widgets[0].color).toBe("red");
  });

  it("(o) a same-batch object swap invalidates dependent pointer walks (refusal, not silent write)", () => {
    const doc = withConflicts(
      { a: { b: 1 } },
      [
        { fieldPath: "/a", field: "a", kind: "field", base: { b: 1 }, ours: { b: 1 }, theirs: { b: 99 } },
        { fieldPath: "/a/b", field: "b", kind: "field", base: 1, ours: 1, theirs: 5 },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/a\/b/);
  });

  it("(p) set-then-delete of the same element follows the replacement chain; delete of a keyed-removed element no-ops", () => {
    const doc = withConflicts(
      { phases: [phase("p1"), phase("p2")] },
      [
        { fieldPath: "/phases/0", field: "phases", kind: "field", base: phase("p1"), ours: phase("p1"), theirs: phaseWith("p1", { name: "P1R" }) },
        { fieldPath: "/phases/0", field: "phases", kind: "delete-edit", base: phase("p1"), ours: phase("p1"), theirs: undefined },
      ],
    );
    resolveDocConflicts(doc, { use: "theirs" });
    expect(ids(doc)).toEqual(["p2"]);

    const doc2 = withConflicts(
      { phases: [phase("p1"), phase("p2")] },
      [
        { fieldPath: "/phases/0", field: "phases[id=p1]", kind: "delete-edit", base: phase("p1"), ours: phase("p1"), theirs: undefined },
        { fieldPath: "/phases/0", field: "phases", kind: "delete-edit", base: phase("p1"), ours: phase("p1"), theirs: undefined },
      ],
    );
    const result2 = resolveDocConflicts(doc2, { use: "theirs" });
    expect(result2.fullyResolved).toBe(true);
    expect(ids(doc2)).toEqual(["p2"]);
  });

  it("(q) ambiguous keyed aliases for the same element refuse relocation", () => {
    const doc = withConflicts(
      { widgets: [{ id: "x", slug: "x", v: 1 }, { id: "y", slug: "y", v: 2 }] },
      [
        { fieldPath: "/widgets/0", field: "widgets[id=x]", kind: "delete-edit", base: null, ours: null, theirs: undefined },
        { fieldPath: "/widgets/0", field: "widgets[slug=x]", kind: "delete-edit", base: null, ours: null, theirs: undefined },
        { fieldPath: "/widgets/0/v", field: "v", kind: "field", base: 1, ours: 1, theirs: 9 },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/widgets\/0\/v/);
    const widgets = doc.widgets as Array<Record<string, unknown>>;
    expect(widgets.find((w) => w.id === "y")!.v).toBe(2);
  });

  it("(s) a pointer-set whose chosen object already lives elsewhere in the array is refused (aliasing guard)", () => {
    const shared = { id: "b" };
    const doc = withConflicts(
      { arr: [{ id: "a" }, shared] },
      [{ fieldPath: "/arr/0", field: "arr", kind: "field", base: null, ours: null, theirs: shared }],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/arr\/0/);
    expect((doc.arr as unknown[]).length).toBe(2);
  });

  it("(t) a delete whose replacement-chain head is a duplicated primitive refuses (never first-match)", () => {
    const doc = withConflicts(
      { items: [{ id: "o1" }, "x"] },
      [
        { fieldPath: "/items/0", field: "items", kind: "field", base: null, ours: null, theirs: "x" },
        { fieldPath: "/items/0", field: "items", kind: "delete-edit", base: null, ours: null, theirs: undefined },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "theirs" })).toThrow(/\/items\/0/);
  });
});

describe("FIX C: applyReorder is type-guarded against same-batch entity desync", () => {
  const phaseWith = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...phase(id), ...extra,
  });

  it("refuses gracefully when a same-batch entity op turns the reorder target into a non-array", () => {
    // Entity op (applied first) replaces the doc with a body where phases is a
    // string; the /phases reorder entry was classified as a reorder at PLAN time
    // (phases was still an array), so apply-time the target has desynced.
    const oursBody = { version: 2, title: "t", phases: "NOT-AN-ARRAY" };
    const theirsBody = { version: 2, title: "t", phases: [phase("p1"), phase("p2")] };
    const doc = withConflicts(
      { version: 2, title: "t", phases: [phase("p1"), phase("p2")] },
      [
        { fieldPath: "", field: "_entity", kind: "field", base: null, ours: oursBody, theirs: theirsBody },
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2"], ours: ["p2", "p1"], theirs: ["p1", "p2"] },
      ],
    );
    // Graceful refusal (pointerError), NOT a bare "arr.every is not a function" TypeError.
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/resolve by hand|--value/i);
  });

  it("refuses gracefully when a mid-walk container becomes a non-object before reorder applies", () => {
    // Deeper reorder path /nested/phases; the entity op collapses `nested` into
    // a string, so the mid-walk `parent[seg]` is no longer a traversable object.
    const oursBody = { version: 2, nested: "NOT-AN-OBJECT" };
    const theirsBody = { version: 2, nested: { phases: [phase("p1"), phase("p2")] } };
    const doc = withConflicts(
      { version: 2, nested: { phases: [phase("p1"), phase("p2")] } },
      [
        { fieldPath: "", field: "_entity", kind: "field", base: null, ours: oursBody, theirs: theirsBody },
        { fieldPath: "/nested/phases", field: "phases", kind: "field", base: ["p1", "p2"], ours: ["p2", "p1"], theirs: ["p1", "p2"] },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/resolve by hand|--value/i);
  });

  it("refuses gracefully when a same-batch entity op leaves the reorder target holding a null element", () => {
    // The target is still an Array (passes Array.isArray), but a same-batch
    // entity op replaced its contents with an array containing null, so the
    // downstream el.id / el.name shape access would bare-TypeError.
    const oursBody = { version: 2, title: "t", phases: [null, phase("p2")] };
    const theirsBody = { version: 2, title: "t", phases: [phase("p1"), phase("p2")] };
    const doc = withConflicts(
      { version: 2, title: "t", phases: [phase("p1"), phase("p2")] },
      [
        { fieldPath: "", field: "_entity", kind: "field", base: null, ours: oursBody, theirs: theirsBody },
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2"], ours: ["p2", "p1"], theirs: ["p1", "p2"] },
      ],
    );
    expect(() => resolveDocConflicts(doc, { use: "ours" })).toThrow(/resolve by hand|--value/i);
  });

  it("does not false-refuse a legitimate same-batch reorder over real object elements", () => {
    // Guard must not over-fire: an entity op that keeps phases as an array of
    // real objects plus a reorder entry must still resolve cleanly.
    const oursBody = { version: 2, title: "t", phases: [phaseWith("p1", { name: "P1-edited" }), phase("p2")] };
    const theirsBody = { version: 2, title: "t", phases: [phase("p1"), phase("p2")] };
    const doc = withConflicts(
      { version: 2, title: "t", phases: [phase("p1"), phase("p2")] },
      [
        { fieldPath: "", field: "_entity", kind: "field", base: null, ours: oursBody, theirs: theirsBody },
        { fieldPath: "/phases", field: "phases", kind: "field", base: ["p1", "p2"], ours: ["p2", "p1"], theirs: ["p1", "p2"] },
      ],
    );
    const result = resolveDocConflicts(doc, { use: "ours" });
    expect(result.fullyResolved).toBe(true);
    const phases = doc.phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.id)).toEqual(["p2", "p1"]);
    // Content of the entity-supplied edit is preserved through the reorder.
    expect(phases.find((p) => p.id === "p1")!.name).toBe("P1-edited");
  });
});
