import { describe, it, expect } from "vitest";
import {
  slotKey,
  instanceKey,
  carryForward,
  mergeConflictSets,
  attachConflicts,
} from "../../src/core/conflict-lifecycle.js";
import type { ConflictEntry } from "../../src/core/merge-driver.js";

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  fieldPath: "/title",
  field: "title",
  kind: "field",
  base: "Old",
  ours: "A",
  theirs: "B",
  ...overrides,
});

function doc(conflicts?: unknown): Record<string, unknown> {
  const d: Record<string, unknown> = { id: "T-001", title: "T" };
  if (conflicts !== undefined) d._conflicts = conflicts;
  return d;
}

describe("conflict-lifecycle: keys", () => {
  it("slotKey combines fieldPath, kind, group", () => {
    expect(slotKey(entry())).toBe("/title\0field\0");
    expect(slotKey(entry({ group: "g1", kind: "coupled" }))).toBe("/title\0coupled\0g1");
  });

  it("instanceKey is stable under key order permutation", () => {
    const a = { fieldPath: "/x", field: "x", kind: "field", base: { z: 1, a: 2 }, ours: 1, theirs: 2 };
    const b = { theirs: 2, ours: 1, base: { a: 2, z: 1 }, kind: "field", field: "x", fieldPath: "/x" };
    expect(instanceKey(a)).toBe(instanceKey(b));
  });

  it("instanceKey differs when content differs", () => {
    expect(instanceKey(entry({ ours: "A" }))).not.toBe(instanceKey(entry({ ours: "A2" })));
  });

  it("instanceKey treats undefined-valued keys as absent (R5)", () => {
    expect(instanceKey(entry({ group: undefined }))).toBe(instanceKey(entry()));
  });
});

describe("conflict-lifecycle: carryForward truth table", () => {
  const e = entry();

  it("base+ours+theirs -> kept once (unresolved on both sides)", () => {
    const out = carryForward(doc([e]), doc([e]), doc([e]));
    expect(out).toHaveLength(1);
    expect(instanceKey(out[0]!)).toBe(instanceKey(e));
  });

  it("base+ours only -> dropped (theirs resolved it)", () => {
    const out = carryForward(doc([e]), doc([e]), doc());
    expect(out).toHaveLength(0);
  });

  it("base+theirs only -> dropped (ours resolved it)", () => {
    const out = carryForward(doc([e]), doc(), doc([e]));
    expect(out).toHaveLength(0);
  });

  it("base only -> dropped (both resolved)", () => {
    const out = carryForward(doc([e]), doc(), doc());
    expect(out).toHaveLength(0);
  });

  it("ours only (not in base) -> kept", () => {
    const out = carryForward(doc(), doc([e]), doc());
    expect(out).toHaveLength(1);
  });

  it("theirs only (not in base) -> kept", () => {
    const out = carryForward(doc(), doc(), doc([e]));
    expect(out).toHaveLength(1);
  });

  it("byte-identical criss-cross copies in ours+theirs dedup to one", () => {
    const out = carryForward(doc(), doc([e]), doc([{ ...e }]));
    expect(out).toHaveLength(1);
  });

  it("same-slot different-content carried pair dedups to ours' copy (R2)", () => {
    const oursCopy = entry({ ours: "from-ours-line" });
    const theirsCopy = entry({ ours: "from-theirs-line" });
    const out = carryForward(doc(), doc([oursCopy]), doc([theirsCopy]));
    expect(out).toHaveLength(1);
    expect(out[0]!.ours).toBe("from-ours-line");
  });

  it("cross-generation: old entry in base only + NEW same-slot entry in ours -> new carried, old dropped", () => {
    const oldEntry = entry({ base: "Ancient", ours: "old-a", theirs: "old-b" });
    const newEntry = entry({ base: "Recent", ours: "new-a", theirs: "new-b" });
    const out = carryForward(doc([oldEntry]), doc([newEntry]), doc());
    expect(out).toHaveLength(1);
    expect(out[0]!.base).toBe("Recent");
  });

  it("ignores non-array and garbage _conflicts inputs (I6)", () => {
    expect(carryForward(doc("junk"), doc([e, 42, null, "x"]), doc({ not: "array" }))).toHaveLength(1);
    expect(carryForward(doc(), doc(), doc())).toHaveLength(0);
  });
});

describe("conflict-lifecycle: mergeConflictSets", () => {
  it("fresh replaces carried on the same slot", () => {
    const stale = entry({ ours: "stale-o", theirs: "stale-t" });
    const fresh = entry({ ours: "fresh-o", theirs: "fresh-t" }) as unknown as ConflictEntry;
    const out = mergeConflictSets([stale], [fresh]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!.ours).toBe("fresh-o");
  });

  it("keeps carried entries on other slots, surviving carried first then fresh", () => {
    const carriedOther = entry({ fieldPath: "/phase", field: "phase" });
    const fresh = entry() as unknown as ConflictEntry;
    const out = mergeConflictSets([carriedOther], [fresh]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(out[0]!.fieldPath).toBe("/phase");
    expect(out[1]!.fieldPath).toBe("/title");
  });
});

describe("conflict-lifecycle: attachConflicts", () => {
  it("sets _conflicts when non-empty", () => {
    const merged: Record<string, unknown> = { id: "T-001" };
    attachConflicts(merged, [entry()]);
    expect(Array.isArray(merged._conflicts)).toBe(true);
  });

  it("deletes _conflicts when empty", () => {
    const merged: Record<string, unknown> = { id: "T-001", _conflicts: [entry()] };
    attachConflicts(merged, []);
    expect("_conflicts" in merged).toBe(false);
  });
});
