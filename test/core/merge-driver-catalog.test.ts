import { describe, it, expect, afterEach, vi } from "vitest";
import { git as fixtureGit } from "../helpers/git-fixture.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// Namespace imports for every module whose T-529 symbols are new: against the
// dispatch base a missing export is `undefined` at the call, so each case goes
// RED on its own instead of the whole file failing to load.
import * as driver from "../../src/core/merge-driver.js";
import * as lifecycle from "../../src/core/conflict-lifecycle.js";
import * as capModel from "../../src/models/capability.js";
import * as glossModel from "../../src/models/glossary.js";
import { ConflictEntrySchema } from "../../src/models/types.js";
import { handleMergeDriver, finalizeMergeOutput, type MergeStrategy } from "../../src/cli/commands/merge-driver.js";
import {
  capabilityCatalog,
  handleCapabilityAdd,
  handleCapabilityUpdate,
  handleCapabilityDefer,
  handleCapabilityList,
  handleCapabilityGet,
  handleCapabilityMatch,
  handleCapabilityCheck,
} from "../../src/cli/commands/capability.js";
import { handleTermAdd } from "../../src/cli/commands/term.js";
import { handleConflictsList, handleConflictsShow } from "../../src/cli/commands/conflicts.js";
import { handleValidateWithSourceRefs } from "../../src/cli/commands/validate.js";
import { glossaryCatalog } from "../../src/core/glossary.js";
import { initProject } from "../../src/core/init.js";
import { makeState } from "./test-factories.js";
import type { CommandContext } from "../../src/cli/run.js";

/**
 * T-529: the structural merge for `.story/capabilities.json` and
 * `.story/glossary.json`, and the readers that must not treat a conflicted
 * entry as settled.
 */

type Doc = Record<string, unknown>;
type Rec = Record<string, unknown>;

const SHA_A = "a".repeat(12);
const SHA_B = "b".repeat(12);

function cap(id: string, over: Rec = {}): Rec {
  return {
    id,
    name: `Name ${id}`,
    summary: `Summary of ${id}.`,
    surfaces: {},
    entryPoints: [`src/${id}.ts`],
    contract: `Contract of ${id}.`,
    checkedAt: { sha: SHA_A, date: "2026-09-20" },
    status: "current",
    ...over,
  };
}

function term(id: string, word: string, over: Rec = {}): Rec {
  return {
    id,
    term: word,
    definition: `What ${word} means here.`,
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...over,
  };
}

function caps(entries: Rec[], conflicts?: Rec[]): Doc {
  return { version: 1, capabilities: entries, ...(conflicts ? { _conflicts: conflicts } : {}) };
}

function terms(entries: Rec[], conflicts?: Rec[]): Doc {
  return { version: 1, terms: entries, ...(conflicts ? { _conflicts: conflicts } : {}) };
}

function mergeCaps(b: Doc, o: Doc, t: Doc) {
  return driver.mergeCatalog(b, o, t, "capabilities");
}

function mergeTerms(b: Doc, o: Doc, t: Doc) {
  return driver.mergeCatalog(b, o, t, "terms");
}

function recordsOf(merged: Doc): Rec[] {
  return (merged._conflicts as Rec[] | undefined) ?? [];
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A stamp: re-pointed at a new checkpoint, marked current, owed work cleared. */
function stamped(entry: Rec): Rec {
  const { pendingNote: _cleared, ...rest } = entry;
  return { ...rest, checkedAt: { sha: SHA_B, date: "2026-09-22" }, status: "current" };
}

describe("T-529: mergeCatalog, entries by id", () => {
  it("add/add of different capabilities: both land, clean", () => {
    const base = caps([cap("cap-a")]);
    const r = mergeCaps(base, caps([cap("cap-a"), cap("cap-b")]), caps([cap("cap-a"), cap("cap-c")]));
    expect(r.clean).toBe(true);
    expect((r.merged.capabilities as Rec[]).map((c) => c.id)).toEqual(["cap-a", "cap-b", "cap-c"]);
    expect(r.merged._conflicts).toBeUndefined();
  });

  it("add/add of different terms: both land, clean", () => {
    const r = mergeTerms(terms([]), terms([term("term-a", "pen")]), terms([term("term-b", "hands")]));
    expect(r.clean).toBe(true);
    expect((r.merged.terms as Rec[]).map((t) => t.id)).toEqual(["term-a", "term-b"]);
  });

  it("same entry, different fields: merged field by field, clean (a member on one side, a non-member on the other)", () => {
    const base = caps([cap("cap-a")]);
    const ours = caps([cap("cap-a", { summary: "Ours summary." })]);
    const theirs = caps([cap("cap-a", { contract: "Theirs contract." })]);
    const r = mergeCaps(base, ours, theirs);
    expect(r.clean).toBe(true);
    const merged = (r.merged.capabilities as Rec[])[0]!;
    expect(merged.summary).toBe("Ours summary.");
    expect(merged.contract).toBe("Theirs contract.");
  });

  it("same field diverges: one conflict at the element path, carrying entityId", () => {
    const base = caps([cap("cap-z"), cap("cap-a")]);
    const r = mergeCaps(
      base,
      caps([cap("cap-z"), cap("cap-a", { summary: "Ours." })]),
      caps([cap("cap-z"), cap("cap-a", { summary: "Theirs." })]),
    );
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ fieldPath: "/capabilities/1/summary", kind: "field", entityId: "cap-a", ours: "Ours.", theirs: "Theirs." });
  });

  it("the same capability id added on both sides with different names is an add/add element record carrying entityId, not a silent pick", () => {
    const r = mergeCaps(caps([]), caps([cap("cap-a", { name: "Alpha" })]), caps([cap("cap-a", { name: "Aleph" })]));
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    const rec = r.conflicts[0]!;
    expect(rec).toMatchObject({ fieldPath: "/capabilities/0", kind: "array-element", entityId: "cap-a" });
    expect((rec.ours as Rec).name).toBe("Alpha");
    expect((rec.theirs as Rec).name).toBe("Aleph");
    // One entry, so no cross-entry collision record on top.
    expect(r.conflicts.some((c) => c.kind === "invariant")).toBe(false);
  });

  it("a divergent version is a document-level field record with no entityId", () => {
    const r = mergeCaps(caps([]), { version: 2, capabilities: [] }, { version: 3, capabilities: [] });
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual([{ fieldPath: "/version", field: "version", kind: "field", base: 1, ours: 2, theirs: 3 }]);
    expect("entityId" in r.conflicts[0]!).toBe(false);
  });

  it("the driver's merged file is not re-sorted: record indexes point into the output order", () => {
    const base = caps([cap("cap-b")]);
    const r = mergeCaps(base, caps([cap("cap-b", { summary: "O." }), cap("cap-a")]), caps([cap("cap-b", { summary: "T." })]));
    const out = r.merged.capabilities as Rec[];
    expect(out.map((c) => c.id)).toEqual(["cap-b", "cap-a"]);
    expect(r.conflicts[0]).toMatchObject({ fieldPath: "/capabilities/0/summary", entityId: "cap-b" });
  });
});

describe("T-529: the capability verification group merges as ONE unit", () => {
  const MEMBERS = ["entryPoints", "contract", "surfaces", "checkedAt", "status", "pendingNote"];

  it("the rule table registers the six-member verification group, keep-ours, and no term group", async () => {
    const { getCoupledGroups } = await import("../../src/core/field-classification.js");
    const groups = getCoupledGroups("capability" as never);
    expect(groups.map((g) => g.group)).toEqual(["verification"]);
    expect([...groups[0]!.members].sort()).toEqual([...MEMBERS].sort());
    expect(groups[0]!.onDivergence).toBe("keep-ours");
    expect(getCoupledGroups("term" as never)).toEqual([]);
  });

  for (const orientation of ["ours edits, theirs stamps", "ours stamps, theirs edits"] as const) {
    it(`payload edit vs stamp (${orientation}): exactly one coupled record by id, the entry keeps OURS' group whole`, () => {
      const baseEntry = cap("cap-a");
      const edited = cap("cap-a", { contract: "A new contract nobody has inspected." });
      const stamp = stamped(baseEntry);
      const [oursEntry, theirsEntry] = orientation === "ours edits, theirs stamps" ? [edited, stamp] : [stamp, edited];
      const r = mergeCaps(caps([cap("cap-0"), baseEntry]), caps([cap("cap-0"), oursEntry]), caps([cap("cap-0"), theirsEntry]));
      expect(r.clean).toBe(false);
      expect(r.conflicts).toHaveLength(1);
      const rec = r.conflicts[0]!;
      expect(rec).toMatchObject({ fieldPath: "/capabilities/1", kind: "coupled", group: "verification", entityId: "cap-a" });
      expect("field" in rec).toBe(false);
      const merged = (r.merged.capabilities as Rec[])[1]!;
      // Never "the new contract with the new stamp": the group is one side's.
      for (const m of MEMBERS) expect(merged[m], m).toEqual(oursEntry[m]);
      expect(merged.contract === edited.contract && (merged.checkedAt as Rec).sha === SHA_B).toBe(false);
      // Payloads are objects keyed by member, one per side.
      for (const side of ["base", "ours", "theirs"] as const) {
        expect(Array.isArray(rec[side])).toBe(false);
        expect(typeof rec[side]).toBe("object");
      }
      expect((rec.ours as Rec).contract).toBe(oursEntry.contract);
      expect((rec.theirs as Rec).checkedAt).toEqual(theirsEntry.checkedAt);
    });
  }

  for (const orientation of ["ours defers, theirs stamps", "ours stamps, theirs defers"] as const) {
    it(`pending vs stamp (${orientation}): one record; the side without a note has NO pendingNote key in its payload`, () => {
      const baseEntry = cap("cap-a");
      const deferred = cap("cap-a", { pendingNote: "Re-read the lock path after the rename.", status: "review" });
      const stamp = stamped(baseEntry);
      const [oursEntry, theirsEntry] = orientation === "ours defers, theirs stamps" ? [deferred, stamp] : [stamp, deferred];
      const r = mergeCaps(caps([baseEntry]), caps([oursEntry]), caps([theirsEntry]));
      expect(r.clean).toBe(false);
      expect(r.conflicts).toHaveLength(1);
      const rec = r.conflicts[0]!;
      expect(rec).toMatchObject({ kind: "coupled", group: "verification", entityId: "cap-a" });
      const withNote = orientation === "ours defers, theirs stamps" ? "ours" : "theirs";
      const withoutNote = withNote === "ours" ? "theirs" : "ours";
      expect((rec[withNote] as Rec).pendingNote).toBe("Re-read the lock path after the rename.");
      expect(Object.keys(rec[withoutNote] as Rec)).not.toContain("pendingNote");
      expect(Object.keys(rec.base as Rec)).not.toContain("pendingNote");
      const merged = (r.merged.capabilities as Rec[])[0]!;
      expect("pendingNote" in merged).toBe("pendingNote" in oursEntry);
    });
  }

  it("absent, undefined and explicit null for a member, before and after a JSON round trip; unrelated fields byte-for-byte", () => {
    const baseEntry = cap("cap-a", { example: "cap example", pendingNote: "old note" });
    // ours: pendingNote ABSENT, example untouched; theirs: pendingNote UNDEFINED
    // in memory and contract changed; an explicit null on surfaces on ours.
    const { pendingNote: _drop, ...oursBody } = baseEntry;
    const oursEntry = { ...oursBody, surfaces: null, contract: "Ours contract." };
    const theirsEntry = { ...baseEntry, pendingNote: undefined, contract: "Theirs contract." };
    const r = mergeCaps(caps([baseEntry]), caps([oursEntry]), caps([theirsEntry]));
    const rec = r.conflicts.find((c) => c.kind === "coupled")!;
    for (const payload of [rec, roundTrip(rec)]) {
      expect(Object.keys(payload.ours as Rec)).not.toContain("pendingNote");
      expect(Object.keys(payload.theirs as Rec)).not.toContain("pendingNote");
      expect((payload.ours as Rec).surfaces).toBeNull();
      expect(Object.keys(payload.ours as Rec)).toContain("surfaces");
      expect((payload.base as Rec).pendingNote).toBe("old note");
    }
    const merged = (r.merged.capabilities as Rec[])[0]!;
    for (const k of ["id", "name", "summary", "example"]) expect(JSON.stringify(merged[k])).toBe(JSON.stringify(baseEntry[k]));
    expect(roundTrip(r.merged)).toEqual(JSON.parse(JSON.stringify(r.merged)));
  });

  it("a group only one side changed is taken whole from that side, clean", () => {
    const baseEntry = cap("cap-a");
    const r = mergeCaps(caps([baseEntry]), caps([cap("cap-a", { name: "Renamed" })]), caps([stamped(baseEntry)]));
    expect(r.clean).toBe(true);
    const merged = (r.merged.capabilities as Rec[])[0]!;
    expect(merged.name).toBe("Renamed");
    expect(merged.checkedAt).toEqual({ sha: SHA_B, date: "2026-09-22" });
  });

  it("both sides making the IDENTICAL group change is clean, alongside different edits outside the group", () => {
    // The entries differ outside the group, so the element merger runs rather
    // than the whole-entry short cut for identical sides.
    const baseEntry = cap("cap-a");
    const ours = { ...stamped(baseEntry), name: "Renamed by ours" };
    const theirs = { ...stamped(baseEntry), summary: "Summarised by theirs." };
    const r = mergeCaps(caps([baseEntry]), caps([ours]), caps([theirs]));
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    const merged = (r.merged.capabilities as Rec[])[0]!;
    expect(merged).toMatchObject({ name: "Renamed by ours", summary: "Summarised by theirs.", checkedAt: { sha: SHA_B, date: "2026-09-22" } });
  });

  it("entityId is never null and every record survives a JSON round trip unchanged", () => {
    const base = caps([cap("cap-a"), cap("cap-b")]);
    const r = mergeCaps(
      base,
      { version: 2, capabilities: [cap("cap-a", { summary: "O" }), stamped(cap("cap-b"))] },
      { version: 3, capabilities: [cap("cap-a", { summary: "T" }), cap("cap-b", { contract: "T contract" })] },
    );
    for (const rec of recordsOf(r.merged)) {
      if ("entityId" in rec) expect(typeof rec.entityId).toBe("string");
      expect(rec.entityId).not.toBeNull();
    }
    expect(roundTrip(recordsOf(r.merged))).toEqual(recordsOf(roundTrip(r.merged)));
    expect(recordsOf(roundTrip(r.merged)).map((c) => ConflictEntrySchema.safeParse(c).success)).toEqual(recordsOf(r.merged).map(() => true));
  });
});

describe("T-529: glossary fields merge field by field (no term group)", () => {
  it("concurrent definition and distinction edits on one term merge clean", () => {
    const base = terms([term("term-a", "pen")]);
    const r = mergeTerms(base, terms([term("term-a", "pen", { definition: "Ours." })]), terms([term("term-a", "pen", { distinction: "Not the hands." })]));
    expect(r.clean).toBe(true);
    expect((r.merged.terms as Rec[])[0]).toMatchObject({ definition: "Ours.", distinction: "Not the hands." });
  });

  for (const clearing of ["ours", "theirs"] as const) {
    it(`defer-vs-clear: ${clearing} clears a note the other side left alone, the clear lands clean`, () => {
      const noted = term("term-a", "pen", { pendingNote: "Say what it is not." });
      const { pendingNote: _n, ...cleared } = noted;
      const [o, t] = clearing === "ours" ? [cleared, noted] : [noted, cleared];
      const r = mergeTerms(terms([noted]), terms([o]), terms([t]));
      expect(r.clean).toBe(true);
      expect("pendingNote" in (r.merged.terms as Rec[])[0]!).toBe(false);
    });

    it(`defer-vs-clear: ${clearing} clears a note the other side CHANGED, one delete-edit record carrying entityId`, () => {
      const noted = term("term-a", "pen", { pendingNote: "Say what it is not." });
      const { pendingNote: _n, ...cleared } = noted;
      const changed = { ...noted, pendingNote: "Say what it is not, and link cap-duet." };
      const [o, t] = clearing === "ours" ? [cleared, changed] : [changed, cleared];
      const r = mergeTerms(terms([noted]), terms([o]), terms([t]));
      expect(r.clean).toBe(false);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0]).toMatchObject({ fieldPath: "/terms/0/pendingNote", kind: "delete-edit", entityId: "term-a" });
    });
  }
});

describe("T-529: the post-merge invariant pass", () => {
  it("a term claimed by one side and aliased by the other: one term-owner invariant record, merge not clean", () => {
    const r = mergeTerms(
      terms([]),
      terms([term("term-b", "pen")]),
      terms([term("term-a", "manager", { aliases: ["Pen"] })]),
    );
    expect(r.clean).toBe(false);
    const inv = r.conflicts.filter((c) => c.kind === "invariant");
    expect(inv).toEqual([
      { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"], base: undefined, ours: undefined, theirs: undefined },
    ]);
    // Serialized, the undefined payloads are omitted, never null.
    expect(Object.keys(roundTrip(recordsOf(r.merged))[0]!)).toEqual(["fieldPath", "kind", "rule", "key", "entityIds"]);
  });

  it("the same word as two terms on two branches: one record naming both", () => {
    const r = mergeTerms(terms([]), terms([term("term-x", "Wave")]), terms([term("term-y", "wave ")]));
    expect(r.conflicts.filter((c) => c.kind === "invariant")).toMatchObject([{ rule: "term-owner", key: "wave", entityIds: ["term-x", "term-y"] }]);
  });

  it("two capabilities given one name on two branches: one capability-name invariant record", () => {
    const r = mergeCaps(caps([]), caps([cap("cap-a", { name: "Merge driver" })]), caps([cap("cap-b", { name: " merge DRIVER" })]));
    expect(r.clean).toBe(false);
    expect(r.conflicts.filter((c) => c.kind === "invariant")).toMatchObject([{ fieldPath: "/capabilities", rule: "capability-name", key: "merge driver", entityIds: ["cap-a", "cap-b"] }]);
  });

  it("the merged document with its invariant record loads through the real schema; without the record it does not", () => {
    const r = mergeTerms(terms([]), terms([term("term-b", "pen")]), terms([term("term-a", "manager", { aliases: ["pen"] })]));
    const merged = roundTrip(r.merged);
    expect(glossModel.GlossaryCatalogSchema.safeParse(merged).success).toBe(true);
    const { _conflicts: _c, ...bare } = merged;
    expect(glossModel.GlossaryCatalogSchema.safeParse(bare).success).toBe(false);
  });

  it("the invariant pass runs AFTER carry-forward: a carried record is not recorded twice, and the merge is clean", () => {
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    const record = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };
    const base = terms(collided, [record]);
    const ours = terms([...collided, term("term-c", "hands")], [record]);
    const theirs = terms([...collided, term("term-d", "floor")], [record]);
    const r = mergeTerms(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(recordsOf(r.merged)).toEqual([record]);
  });

  it("a carried record naming only some claimants does not cover a new third one: a fresh record naming all three supersedes it", () => {
    const record = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    const base = terms(collided, [record]);
    const r = mergeTerms(base, terms([...collided, term("term-c", "writer", { aliases: ["PEN"] })], [record]), terms(collided, [record]));
    expect(r.clean).toBe(false);
    expect(recordsOf(r.merged)).toMatchObject([{ kind: "invariant", key: "pen", entityIds: ["term-a", "term-b", "term-c"] }]);
  });

  it("a carried record survives a fresh record for ANOTHER entry at the index it was recorded at", () => {
    // cap-b's record was written when cap-b sat at index 0; a later merge put
    // cap-a in front of it. A fresh conflict on cap-a now lands at index 0.
    const carried = {
      fieldPath: "/capabilities/0",
      kind: "coupled",
      group: "verification",
      entityId: "cap-b",
      base: { contract: "b0" },
      ours: { contract: "b1" },
      theirs: { contract: "b2" },
    };
    const a = cap("cap-a");
    const b = cap("cap-b");
    const base = caps([a, b], [carried]);
    const r = mergeCaps(base, caps([cap("cap-a", { contract: "Ours." }), b], [carried]), caps([stamped(a), b], [carried]));
    const out = recordsOf(r.merged);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.entityId === "cap-b")).toEqual(carried);
    expect(out.find((c) => c.entityId === "cap-a")).toMatchObject({ fieldPath: "/capabilities/0", kind: "coupled", group: "verification" });
  });
});

describe("T-529: the conflict record shape (ConflictEntrySchema) and lifecycle keys", () => {
  const invariant = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };

  it("accepts an invariant record; refuses one missing its rule, key, or a second distinct entry", () => {
    expect(ConflictEntrySchema.safeParse(invariant).success).toBe(true);
    expect(ConflictEntrySchema.safeParse({ ...invariant, rule: undefined }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...invariant, rule: "no-such-rule" }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...invariant, key: undefined }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...invariant, entityIds: ["term-a"] }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...invariant, entityIds: ["term-a", "term-a"] }).success).toBe(false);
  });

  it("a catalog group record's payloads are objects: a positional array is refused by the schema", () => {
    const group = { fieldPath: "/capabilities/0", kind: "coupled", group: "verification", entityId: "cap-a", base: {}, ours: { contract: "x" }, theirs: {} };
    expect(ConflictEntrySchema.safeParse(group).success).toBe(true);
    expect(ConflictEntrySchema.safeParse({ ...group, ours: ["x", null] }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...group, theirs: "x" }).success).toBe(false);
    expect(ConflictEntrySchema.safeParse({ ...group, entityId: null }).success).toBe(false);
  });

  it("every side of a catalog group record is present: an empty object parses, a missing side does not", () => {
    const group = { fieldPath: "/capabilities/0", kind: "coupled", group: "verification", entityId: "cap-a", base: {}, ours: {}, theirs: {} };
    expect(ConflictEntrySchema.safeParse(group).success).toBe(true);
    for (const side of ["base", "ours", "theirs"] as const) {
      const { [side]: _gone, ...missing } = group;
      expect(ConflictEntrySchema.safeParse(missing).success, side).toBe(false);
      expect(ConflictEntrySchema.safeParse({ ...group, [side]: undefined }).success, side).toBe(false);
    }
  });

  it("legacy per-member coupled records keep their scalar payloads and still parse", () => {
    expect(ConflictEntrySchema.safeParse({ fieldPath: "/status", field: "status", kind: "coupled", group: "ticket-status", base: "open", ours: "complete", theirs: "inprogress" }).success).toBe(true);
    expect(ConflictEntrySchema.safeParse({ fieldPath: "/updatedAt", field: "updatedAt", kind: "coupled", group: "attribution", base: null, ours: "2026-01-01", theirs: "2026-01-02" }).success).toBe(true);
  });

  it("instanceKey of a legacy record is byte-identical to the pre-T-529 key; an explicit null entityId changes it (so none is ever written)", () => {
    const legacy = { fieldPath: "/title", field: "title", kind: "field", base: "a", ours: "b", theirs: "c" };
    expect(lifecycle.instanceKey(legacy)).toBe('{"base":"a","field":"title","fieldPath":"/title","kind":"field","ours":"b","theirs":"c"}');
    expect(lifecycle.instanceKey({ ...legacy, entityId: undefined })).toBe(lifecycle.instanceKey(legacy));
    expect(lifecycle.instanceKey({ ...legacy, entityId: null })).not.toBe(lifecycle.instanceKey(legacy));
  });

  it("instanceKey distinguishes two invariant records that differ only in their catalog fields", () => {
    expect(lifecycle.instanceKey({ ...invariant, key: "hands" })).not.toBe(lifecycle.instanceKey(invariant));
    expect(lifecycle.instanceKey({ ...invariant, entityIds: ["term-a", "term-c"] })).not.toBe(lifecycle.instanceKey(invariant));
  });

  it("slotKey of a legacy record is unchanged; a catalog record's slot is its entry, not its index", () => {
    expect(lifecycle.slotKey({ fieldPath: "/title", kind: "field" })).toBe("/title\0field\0");
    const one = { fieldPath: "/capabilities/0", kind: "coupled", group: "verification", entityId: "cap-a" };
    expect(lifecycle.slotKey({ ...one, fieldPath: "/capabilities/3" })).toBe(lifecycle.slotKey(one));
    expect(lifecycle.slotKey({ ...one, entityId: "cap-b" })).not.toBe(lifecycle.slotKey(one));
  });
});

describe("T-529: document schemas, collision tolerance and the capability-name rule", () => {
  const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen"), term("term-c", "hands")];
  const record = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };

  it("an unrecorded term collision is refused with the same message as before T-529", () => {
    const res = glossModel.GlossaryCatalogSchema.safeParse(terms(collided));
    expect(res.success).toBe(false);
    expect(res.error!.issues.map((i) => i.message)).toContain("pen is already owned by terms.0 (its alias pen); one word belongs to one entry");
  });

  it("a collision the file's own record names in full is tolerated", () => {
    expect(glossModel.GlossaryCatalogSchema.safeParse(terms(collided, [record])).success).toBe(true);
  });

  it("a record that names only some claimants, or another key, does not cover the collision", () => {
    const three = [...collided, term("term-d", "writer", { aliases: ["Pen"] })];
    expect(glossModel.GlossaryCatalogSchema.safeParse(terms(three, [record])).success).toBe(false);
    expect(glossModel.GlossaryCatalogSchema.safeParse(terms(collided, [{ ...record, key: "hands" }])).success).toBe(false);
    expect(glossModel.GlossaryCatalogSchema.safeParse(terms(collided, [{ ...record, rule: "capability-name" }])).success).toBe(false);
  });

  it("capability names are unique under NFKC, lower case and trim; the load refuses a duplicate", () => {
    for (const other of ["merge driver", "  Merge Driver ", "Ｍｅｒｇｅ driver"]) {
      const res = capModel.CapabilityCatalogSchema.safeParse(caps([cap("cap-a", { name: "Merge Driver" }), cap("cap-b", { name: other })]));
      expect(res.success, other).toBe(false);
      expect(res.error!.issues[0]!.path).toEqual(["capabilities", 1, "name"]);
      expect(res.error!.issues[0]!.message).toBe(`Capability name ${other} is already used by capabilities.0; one name belongs to one capability`);
    }
    expect(capModel.CapabilityCatalogSchema.safeParse(caps([cap("cap-a", { name: "Merge driver" }), cap("cap-b", { name: "Merge drivers" })])).success).toBe(true);
  });

  it("a recorded capability-name collision is tolerated; the same collision unrecorded is not", () => {
    const entries = [cap("cap-a", { name: "Merge" }), cap("cap-b", { name: "merge" })];
    expect(capModel.CapabilityCatalogSchema.safeParse(caps(entries)).success).toBe(false);
    const doc = caps(entries, [{ fieldPath: "/capabilities", kind: "invariant", rule: "capability-name", key: "merge", entityIds: ["cap-a", "cap-b"] }]);
    expect(capModel.CapabilityCatalogSchema.safeParse(doc).success).toBe(true);
  });

  it("the violation walkers name every claimant once, sorted", () => {
    expect(glossModel.termOwnerViolations(collided)).toEqual([{ rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] }]);
    expect(capModel.capabilityNameViolations([cap("cap-c", { name: "X" }), cap("cap-a", { name: "x" }), cap("cap-b", { name: " X" })])).toEqual([
      { rule: "capability-name", key: "x", entityIds: ["cap-a", "cap-b", "cap-c"] },
    ]);
  });
});

// --- the CLI driver: dispatch, gate and fallback ---

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf-8");
  return p;
}

describe("T-529: the merge-driver command routes both catalog files", () => {
  it("capabilities.json: add/add merges clean, exit 0, and the output loads", () => {
    const dir = tmp("cat-merge-");
    const base = writeJson(dir, "base.json", caps([cap("cap-a")]));
    const ours = writeJson(dir, "ours.json", caps([cap("cap-a"), cap("cap-b")]));
    const theirs = writeJson(dir, "theirs.json", caps([cap("cap-a"), cap("cap-c")]));
    expect(handleMergeDriver(base, ours, theirs, ".story/capabilities.json")).toBe(0);
    const out = JSON.parse(readFileSync(ours, "utf-8"));
    expect(out.capabilities.map((c: Rec) => c.id)).toEqual(["cap-a", "cap-b", "cap-c"]);
    expect(capModel.CapabilityCatalogSchema.safeParse(out).success).toBe(true);
  });

  it("glossary.json: a post-merge collision exits 1 with the invariant record written, and the output loads", () => {
    const dir = tmp("cat-merge-");
    const base = writeJson(dir, "base.json", terms([]));
    const ours = writeJson(dir, "ours.json", terms([term("term-b", "pen")]));
    const theirs = writeJson(dir, "theirs.json", terms([term("term-a", "manager", { aliases: ["pen"] })]));
    expect(handleMergeDriver(base, ours, theirs, ".story/glossary.json")).toBe(1);
    const out = JSON.parse(readFileSync(ours, "utf-8"));
    expect(out._conflicts).toEqual([{ fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] }]);
    expect(glossModel.GlossaryCatalogSchema.safeParse(out).success).toBe(true);
  });

  it("an add/add of the whole file (empty ancestor) still merges structurally", () => {
    const dir = tmp("cat-merge-");
    const base = join(dir, "base.json");
    writeFileSync(base, "");
    const ours = writeJson(dir, "ours.json", caps([cap("cap-a")]));
    const theirs = writeJson(dir, "theirs.json", caps([cap("cap-b")]));
    expect(handleMergeDriver(base, ours, theirs, ".story/capabilities.json")).toBe(0);
    expect(JSON.parse(readFileSync(ours, "utf-8")).capabilities.map((c: Rec) => c.id)).toEqual(["cap-a", "cap-b"]);
  });
});

describe("T-529: a SERIALIZED invariant record through the driver's fallback is CARRIED, not dropped", () => {
  const invariantRecord = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };

  it("on the entity path (the enum filter in isolation): the carried invariant record survives the fallback", () => {
    const ticket = { id: "T-001", title: "Test", description: "", type: "task", status: "open", phase: "p1", order: 10, createdDate: "2026-01-01", blockedBy: [], parentTicket: null, completedDate: null };
    const withRecord = { ...ticket, _conflicts: [invariantRecord] };
    const strategy: MergeStrategy = { kind: "entity", entityType: "ticket" };
    const diag = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const final = finalizeMergeOutput(strategy, withRecord, withRecord, withRecord, { merged: { garbage: true }, conflicts: [], clean: true });
    expect("hardError" in final).toBe(false);
    if ("hardError" in final) return;
    const entries = final.merged._conflicts as Rec[];
    expect(entries.map((e) => e.kind)).toEqual(["field", "invariant"]);
    expect(entries[1]).toEqual(invariantRecord);
    expect(diag.mock.calls.map((c) => String(c[0])).join("")).not.toContain("dropping malformed");
  });

  it("on the catalog path: a merge whose output fails the gate falls back to ours plus the whole-document record, keeping the carried invariant", () => {
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    const doc = terms(collided, [invariantRecord]);
    const final = finalizeMergeOutput({ kind: "catalog", key: "terms" } as MergeStrategy, doc, doc, doc, { merged: { version: 1, terms: "garbage" }, conflicts: [], clean: true });
    expect("hardError" in final).toBe(false);
    if ("hardError" in final) return;
    expect(final.exit).toBe(1);
    expect((final.merged._conflicts as Rec[])[1]).toEqual(invariantRecord);
    expect(glossModel.GlossaryCatalogSchema.safeParse(final.merged).success).toBe(true);
  });

  it("the command end to end: a divergence carried with the invariant record writes a loadable file still holding the record", () => {
    const dir = tmp("cat-merge-");
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    const base = writeJson(dir, "base.json", terms(collided, [invariantRecord]));
    const ours = writeJson(dir, "ours.json", terms([...collided, term("term-c", "hands")], [invariantRecord]));
    const theirs = writeJson(dir, "theirs.json", terms([...collided, term("term-d", "floor")], [invariantRecord]));
    expect(handleMergeDriver(base, ours, theirs, ".story/glossary.json")).toBe(0);
    const out = JSON.parse(readFileSync(ours, "utf-8"));
    expect(out._conflicts).toEqual([invariantRecord]);
    expect(glossModel.GlossaryCatalogSchema.safeParse(out).success).toBe(true);
  });
});

// --- the readers and writers on a project whose catalog carries records ---

/**
 * Every fixture git call goes through the sandboxed helper: no global or
 * system config (signing, hooks, templates) reaches these repositories.
 */
function git(root: string, ...args: string[]): string {
  return fixtureGit(root, args);
}

/**
 * Standalone temp repositories only (ISS-1220): a linked worktree's fixture
 * git config writes reach the shared `.git/config`.
 */
async function newRepo(): Promise<string> {
  const root = tmp("cat-conflicts-");
  await initProject(root, { name: "Cat", type: "npm" });
  for (const id of ["cap-a", "cap-b", "cap-c", "cap-d"]) {
    mkdirSync(dirname(join(root, "src", `${id}.ts`)), { recursive: true });
    writeFileSync(join(root, "src", `${id}.ts`), `export const id = "${id}";\n`);
  }
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function ctxFor(root: string, format: "md" | "json" = "md"): CommandContext {
  return { state: makeState(), warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

const NAME_RECORD = { fieldPath: "/capabilities", kind: "invariant", rule: "capability-name", key: "merge", entityIds: ["cap-a", "cap-b"] };
const GROUP_RECORD = {
  fieldPath: "/capabilities/2",
  kind: "coupled",
  group: "verification",
  entityId: "cap-c",
  base: { contract: "c0" },
  ours: { contract: "c1" },
  theirs: { contract: "c2" },
};

/**
 * A catalog as a merge leaves it: cap-a and cap-b share a name (recorded),
 * cap-c carries an open verification record, cap-d is untouched. Every entry
 * is stamped at HEAD, so only the records can make any of them `review`.
 */
function writeConflictedCatalog(root: string): string {
  const head = git(root, "rev-parse", "HEAD");
  const at = { sha: head, date: "2026-09-22" };
  const doc = caps(
    [
      cap("cap-a", { name: "Merge", checkedAt: at }),
      cap("cap-b", { name: "merge", checkedAt: at }),
      cap("cap-c", { checkedAt: at }),
      cap("cap-d", { checkedAt: at }),
    ],
    [NAME_RECORD, GROUP_RECORD],
  );
  const path = join(root, ".story", "capabilities.json");
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}

function jsonData(output: string): Rec {
  return (JSON.parse(output) as { data: Rec }).data;
}

describe("T-529: a serialized catalog record through the real loader, conflicts and validate", () => {
  it("the real loader opens both catalogs with their records intact, a recorded collision included", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const { doc } = capabilityCatalog.load(root);
    expect(doc.capabilities).toHaveLength(4);
    expect((doc as Rec)._conflicts).toEqual([NAME_RECORD, GROUP_RECORD]);
    const termRecord = { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] };
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    writeFileSync(join(root, ".story", "glossary.json"), JSON.stringify(terms(collided, [termRecord]), null, 2));
    const glossary = glossaryCatalog.load(root).doc;
    expect(glossary.terms.map((t) => t.id)).toEqual(["term-a", "term-b"]);
    expect((glossary as Rec)._conflicts).toEqual([termRecord]);
  });

  it("conflicts list names capabilities.json with its record count", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const res = await handleConflictsList(root, "json");
    const report = (JSON.parse(res.output) as { data: { items: Rec[] } }).data;
    expect(report.items).toContainEqual({ type: "capabilities", id: "capabilities.json", conflictCount: 2 });
    const md = await handleConflictsList(root, "md");
    expect(md.output).toContain("| capabilities | capabilities.json | 2 |");
  });

  it("conflicts show numbers the invariant record and heads the group record by its entry id", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const md = await handleConflictsShow("capabilities", root, "md");
    expect(md.exitCode).toBeUndefined();
    expect(md.output).toContain('### Invariant 1: capability-name "merge" [invariant]');
    expect(md.output).toContain('- Entries: "cap-a", "cap-b"');
    expect(md.output).toContain('### "cap-c" [coupled] (group: verification)');
    const json = await handleConflictsShow("capabilities.json", root, "json");
    expect(jsonData(json.output).conflicts).toEqual([NAME_RECORD, GROUP_RECORD]);
  });

  it("conflicts show prints no terminal control bytes from the file: paths, group names and payloads are sanitized, the JSON keeps them", async () => {
    const root = await newRepo();
    const hostile = "\u001b]0;owned\u0007\u009b31m\u2028";
    const records = [
      { fieldPath: `/capabilities/0/x${hostile}`, kind: "field", entityId: "cap-a", base: "a", ours: `o${hostile}`, theirs: "t" },
      { fieldPath: "/capabilities/1", kind: "coupled", group: `verification${hostile}`, entityId: "cap-b", base: {}, ours: { contract: hostile }, theirs: {} },
      { fieldPath: `/zz${hostile}`, field: "zz", kind: "field", base: 1, ours: 2, theirs: 3 },
    ];
    writeFileSync(join(root, ".story", "capabilities.json"), JSON.stringify(caps([cap("cap-a"), cap("cap-b")], records), null, 2));
    const md = await handleConflictsShow("capabilities", root, "md");
    expect(md.output).toContain('### "cap-a"');
    expect(md.output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
    const json = await handleConflictsShow("capabilities", root, "json");
    expect((jsonData(json.output).conflicts as Rec[])[1]!.group).toBe(`verification${hostile}`);
  });

  it("validate reports the file's unresolved records and a structural result on every entry they name", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const res = await handleValidateWithSourceRefs(ctxFor(root, "json"));
    const findings = (JSON.parse(res.output) as { data: { findings: Rec[] } }).data.findings;
    expect(findings).toContainEqual(expect.objectContaining({ level: "error", code: "unresolved_conflicts", entity: "capabilities.json" }));
    expect(findings.filter((f) => f.code === "capability_invariant_problem").map((f) => f.entity).sort()).toEqual(["cap-a", "cap-b"]);
    expect(findings.filter((f) => f.code === "capability_conflicted").map((f) => f.entity)).toEqual(["cap-c"]);
    expect(findings.some((f) => f.entity === "cap-d" && String(f.code).startsWith("capability_"))).toBe(false);
  });

  it("a glossary carrying a record is reported by conflicts list and validate too", async () => {
    const root = await newRepo();
    const collided = [term("term-a", "manager", { aliases: ["pen"] }), term("term-b", "pen")];
    writeFileSync(join(root, ".story", "glossary.json"), JSON.stringify(terms(collided, [{ fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] }]), null, 2));
    const list = await handleConflictsList(root, "json");
    expect((JSON.parse(list.output) as { data: { items: Rec[] } }).data.items).toContainEqual({ type: "glossary", id: "glossary.json", conflictCount: 1 });
    const res = await handleValidateWithSourceRefs(ctxFor(root, "json"));
    const findings = (JSON.parse(res.output) as { data: { findings: Rec[] } }).data.findings;
    expect(findings).toContainEqual(expect.objectContaining({ code: "unresolved_conflicts", entity: "glossary.json" }));
  });
});

describe("T-529: a capability a record names is effective review, excluded from match, and refused by --stamp", () => {
  it("list and get: every named entry reads review, the untouched entry reads current", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const list = jsonData((await handleCapabilityList({}, ctxFor(root, "json"))).output);
    const status = Object.fromEntries((list.capabilities as Rec[]).map((c) => [c.id, c.effectiveStatus]));
    expect(status).toEqual({ "cap-a": "review", "cap-b": "review", "cap-c": "review", "cap-d": "current" });
    const get = jsonData((await handleCapabilityGet("cap-c", {}, ctxFor(root, "json"))).output);
    expect(get.effectiveStatus).toBe("review");
    expect((get.results as Rec[]).map((r) => r.code)).toContain("capability_conflicted");
  });

  it("match excludes every named entry, listing each with its reason", async () => {
    const root = await newRepo();
    writeConflictedCatalog(root);
    const res = jsonData((await handleCapabilityMatch({ paths: ["src/cap-c.ts", "src/cap-a.ts", "src/cap-d.ts"] }, ctxFor(root, "json"))).output);
    expect((res.matches as Rec[]).map((m) => m.id)).toEqual(["cap-d"]);
    expect((res.excluded as Rec[]).map((e) => e.id).sort()).toEqual(["cap-a", "cap-b", "cap-c"]);
  });

  it("--stamp of a named entry is refused for that entry even though its paths and checkpoint pass; nothing is written", async () => {
    const root = await newRepo();
    const path = writeConflictedCatalog(root);
    const before = readFileSync(path, "utf-8");
    const res = await handleCapabilityCheck({ stamp: ["cap-c"] }, "json", root, ctxFor(root, "json"));
    const data = jsonData(res.output);
    expect(data.stamped).toEqual([]);
    expect((data.refused as Rec[]).map((r) => r.id)).toEqual(["cap-c"]);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("T-529: while the file carries a record, resolve is its only writer", () => {
  async function expectRefused(run: () => Promise<unknown>, path: string, before: string): Promise<void> {
    await expect(run()).rejects.toThrow(/Cannot write capabilities\.json: it has 2 unresolved merge conflict\(s\) \(entries cap-a, cap-b, cap-c\)\. Run `storybloq conflicts show capabilities\.json`/);
    expect(readFileSync(path, "utf-8")).toBe(before);
  }

  it("defer of an untouched entry is refused", async () => {
    const root = await newRepo();
    const path = writeConflictedCatalog(root);
    const before = readFileSync(path, "utf-8");
    await expectRefused(() => handleCapabilityDefer({ id: "cap-d", note: "Re-read it." }, "md", root, ctxFor(root)), path, before);
  });

  it("--stamp of an untouched entry is refused", async () => {
    const root = await newRepo();
    const path = writeConflictedCatalog(root);
    const before = readFileSync(path, "utf-8");
    await expectRefused(() => handleCapabilityCheck({ stamp: ["cap-d"] }, "md", root, ctxFor(root)), path, before);
  });

  it("update and add are refused", async () => {
    const root = await newRepo();
    const path = writeConflictedCatalog(root);
    const before = readFileSync(path, "utf-8");
    await expectRefused(() => handleCapabilityUpdate({ id: "cap-d", summary: "New." }, "md", root), path, before);
    await expectRefused(
      () => handleCapabilityAdd({ id: "cap-e", name: "E", summary: "E.", entryPoints: ["src/cap-a.ts"], contract: "E." }, "md", root),
      path,
      before,
    );
  });

  it("a conflicted glossary refuses term add the same way", async () => {
    const root = await newRepo();
    const path = join(root, ".story", "glossary.json");
    writeFileSync(path, JSON.stringify(terms([term("term-a", "pen"), term("term-b", "hands")], [{ fieldPath: "/terms/0/definition", field: "definition", kind: "field", entityId: "term-a", base: "x", ours: "y", theirs: "z" }]), null, 2));
    const before = readFileSync(path, "utf-8");
    await expect(handleTermAdd({ id: "term-c", term: "floor", definition: "The cheapest tier." }, "md", root)).rejects.toThrow(
      /Cannot write glossary\.json: it has 1 unresolved merge conflict\(s\) \(entries term-a\)/,
    );
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(glossaryCatalog.load(root).doc.terms).toHaveLength(2);
  });
});

describe("T-529: capability add and update refuse a name another entry uses", () => {
  it("add refuses a name that normalises to an existing one, naming the owner", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ id: "cap-a", name: "Merge Driver", summary: "S.", entryPoints: ["src/cap-a.ts"], contract: "C." }, "md", root);
    const res = await handleCapabilityAdd({ id: "cap-b", name: " merge driver", summary: "S.", entryPoints: ["src/cap-b.ts"], contract: "C." }, "md", root);
    expect(res.exitCode).toBeDefined();
    expect(res.output).toContain("is already used by cap-a");
    expect(capabilityCatalog.load(root).doc.capabilities.map((c) => c.id)).toEqual(["cap-a"]);
  });

  it("update refuses a rename onto another entry's name, and allows re-casing its own", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ id: "cap-a", name: "Alpha", summary: "S.", entryPoints: ["src/cap-a.ts"], contract: "C." }, "md", root);
    await handleCapabilityAdd({ id: "cap-b", name: "Beta", summary: "S.", entryPoints: ["src/cap-b.ts"], contract: "C." }, "md", root);
    const refused = await handleCapabilityUpdate({ id: "cap-b", name: "ALPHA" }, "md", root);
    expect(refused.output).toContain("is already used by cap-a");
    expect(capabilityCatalog.load(root).doc.capabilities.find((c) => c.id === "cap-b")!.name).toBe("Beta");
    const recased = await handleCapabilityUpdate({ id: "cap-b", name: "BETA" }, "md", root);
    expect(recased.exitCode).toBeUndefined();
  });
});
