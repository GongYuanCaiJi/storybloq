import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace imports: against a base without T-529's resolvers a missing
// export is `undefined` at the call, so each case goes RED on its own
// instead of the whole file failing to load.
import * as conflictsCmd from "../../src/cli/commands/conflicts.js";
import * as resolveCore from "../../src/core/resolve.js";
import * as resolveDoc from "../../src/core/resolve-doc.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { glossaryCatalog } from "../../src/core/glossary.js";
import { initProject } from "../../src/core/init.js";
import type { ConflictEntry } from "../../src/models/types.js";

/**
 * T-529: `storybloq resolve capabilities|glossary`. Every case runs the real
 * handler against a real project directory, so the lock, the transaction's
 * schema pass and the write are all in the path; a refusal is asserted to
 * leave the file byte for byte as it was.
 */

type Rec = Record<string, unknown>;

const AT_A = { sha: "a".repeat(12), date: "2026-09-20" };
const AT_B = { sha: "b".repeat(12), date: "2026-09-22" };
const MEMBERS = ["entryPoints", "contract", "surfaces", "checkedAt", "status", "pendingNote"];
const OLD_STAMP = "2026-09-20T10:00:00.000Z";

function cap(id: string, over: Rec = {}): Rec {
  return {
    id,
    name: `Name ${id}`,
    summary: `Summary of ${id}.`,
    surfaces: {},
    entryPoints: [`src/${id}.ts`],
    contract: `Contract of ${id}.`,
    checkedAt: AT_A,
    status: "current",
    ...over,
  };
}

function term(id: string, word: string, over: Rec = {}): Rec {
  return { id, term: word, definition: `What ${word} means here.`, updatedAt: OLD_STAMP, ...over };
}

/** One side of a verification record: the entry's whole group, as the merge driver records it. */
function groupOf(entry: Rec): Rec {
  const out: Rec = {};
  for (const m of MEMBERS) if (Object.hasOwn(entry, m)) out[m] = entry[m];
  return out;
}

function groupRecord(index: number, base: Rec, ours: Rec, theirs: Rec): Rec {
  return {
    fieldPath: `/capabilities/${index}`,
    kind: "coupled",
    group: "verification",
    entityId: ours.id,
    base: groupOf(base),
    ours: groupOf(ours),
    theirs: groupOf(theirs),
  };
}

function nameRecord(key: string, ids: string[]): Rec {
  return { fieldPath: "/capabilities", kind: "invariant", rule: "capability-name", key, entityIds: ids };
}

function wordRecord(key: string, ids: string[]): Rec {
  return { fieldPath: "/terms", kind: "invariant", rule: "term-owner", key, entityIds: ids };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "resolve-catalog-"));
  roots.push(root);
  await initProject(root, { name: "Cat", type: "npm" });
  return root;
}

function path(root: string, file: string): string {
  return join(root, ".story", file);
}

function writeCaps(root: string, entries: Rec[], conflicts?: Rec[]): void {
  const doc = { version: 1, capabilities: entries, ...(conflicts ? { _conflicts: conflicts } : {}) };
  writeFileSync(path(root, "capabilities.json"), JSON.stringify(doc, null, 2) + "\n");
}

function writeTerms(root: string, entries: Rec[], conflicts?: Rec[]): void {
  const doc = { version: 1, terms: entries, ...(conflicts ? { _conflicts: conflicts } : {}) };
  writeFileSync(path(root, "glossary.json"), JSON.stringify(doc, null, 2) + "\n");
}

function read(root: string, file: string): Rec {
  return JSON.parse(readFileSync(path(root, file), "utf-8")) as Rec;
}

function bytes(root: string, file: string): string {
  return readFileSync(path(root, file), "utf-8");
}

type Opts = Rec & { format?: "md" | "json" };

async function run(target: string, root: string, opts: Opts) {
  return conflictsCmd.handleResolve(target, root, { format: "json", ...opts } as never);
}

/** A resolution that succeeds: exit 0, and the JSON envelope's data. */
async function resolved(target: string, root: string, opts: Opts): Promise<Rec> {
  const res = await run(target, root, opts);
  expect(res.exitCode, res.output).toBeUndefined();
  return (JSON.parse(res.output) as { data: Rec }).data;
}

/** A refusal: it throws, the message matches, and neither catalog changed by a byte. */
async function refused(target: string, root: string, opts: Opts, message: RegExp): Promise<void> {
  const files = ["capabilities.json", "glossary.json"].filter((f) => existsSync(path(root, f)));
  const before = files.map((f) => bytes(root, f));
  await expect(run(target, root, opts)).rejects.toThrow(message);
  expect(files.map((f) => bytes(root, f))).toEqual(before);
}

function capsOf(root: string): Rec[] {
  return read(root, "capabilities.json").capabilities as Rec[];
}

function termsOf(root: string): Rec[] {
  return read(root, "glossary.json").terms as Rec[];
}

function entry(list: Rec[], id: string): Rec {
  const found = list.find((e) => e.id === id);
  expect(found, `entry ${id}`).toBeDefined();
  return found!;
}

// ---------------------------------------------------------------------------

describe("T-529: selectConflicts, the legacy forms pinned", () => {
  const coupled = (field: string, group: string): ConflictEntry =>
    ({ fieldPath: `/${field}`, field, kind: "coupled", group, base: 0, ours: 1, theirs: 2 }) as ConflictEntry;
  const plain = (field: string): ConflictEntry =>
    ({ fieldPath: `/${field}`, field, kind: "field", base: 0, ours: 1, theirs: 2 }) as ConflictEntry;

  it("an entity --field: the first match, a coupled record expanded to its whole group, the rest in file order", () => {
    const a = coupled("status", "lifecycle");
    const b = plain("title");
    const c = coupled("completedDate", "lifecycle");
    const d = plain("title");
    const sel = resolveCore.selectConflicts([a, b, c, d], { field: "completedDate" });
    expect(sel.target).toBe(c);
    expect(sel.selected).toEqual([a, c]);
    expect(sel.remaining).toEqual([b, d]);
    const first = resolveCore.selectConflicts([a, b, c, d], { field: "title" });
    expect(first.selected).toEqual([b]);
    expect(first.remaining).toEqual([a, c, d]);
  });

  it("an entity --field that matches nothing keeps its exact message", () => {
    expect(() => resolveCore.selectConflicts([plain("title")], { field: "nope" })).toThrow('No conflict found for field "nope"');
  });

  it("resolveConflicts on an entity: a coupled --field still consumes every record of the group and keeps the rest", () => {
    const entity: Rec = {
      id: "T-001", status: "open", completedDate: null, title: "A",
      _conflicts: [coupled("status", "lifecycle"), plain("title"), coupled("completedDate", "lifecycle")],
    };
    (entity._conflicts as Rec[])[0]!.theirs = "complete";
    (entity._conflicts as Rec[])[2]!.theirs = "2026-09-22";
    const r = resolveCore.resolveConflicts(entity, { field: "status", use: "theirs" });
    expect(r.resolved).toEqual(["status", "completedDate"]);
    expect(entity.status).toBe("complete");
    expect(entity.completedDate).toBe("2026-09-22");
    expect(r.remaining).toBe(1);
    expect((entity._conflicts as Rec[]).map((c) => c.field)).toEqual(["title"]);
  });

  it("resolveDocConflicts (config, roadmap): --field resolves only the record it names; a miss keeps its message", () => {
    const doc: Rec = {
      title: "x", date: "d",
      _conflicts: [plain("title"), plain("date")],
    };
    const r = resolveDoc.resolveDocConflicts(doc, { field: "date", use: "theirs" });
    expect(r.resolved).toEqual(["date"]);
    expect(doc.date).toBe(2);
    expect(doc.title).toBe("x");
    expect((doc._conflicts as Rec[]).map((c) => c.field)).toEqual(["title"]);
    expect(() => resolveDoc.resolveDocConflicts(doc, { field: "nope", use: "theirs" })).toThrow('No conflict found for field "nope"');
  });

  it("a catalog scopes by entry: --id sees only that entry's records, no --id sees only document-level ones", () => {
    const groups = [{ group: "verification", members: MEMBERS }];
    const forA = { fieldPath: "/capabilities/0", kind: "coupled", group: "verification", entityId: "cap-a", base: {}, ours: {}, theirs: {} } as ConflictEntry;
    const forB = { fieldPath: "/capabilities/1", kind: "coupled", group: "verification", entityId: "cap-b", base: {}, ours: {}, theirs: {} } as ConflictEntry;
    const summaryB = { fieldPath: "/capabilities/1/summary", field: "summary", kind: "field", entityId: "cap-b", base: 0, ours: 1, theirs: 2 } as ConflictEntry;
    const version = { fieldPath: "/version", field: "version", kind: "field", base: 1, ours: 1, theirs: 2 } as ConflictEntry;
    const name = nameRecord("merge", ["cap-a", "cap-b"]) as ConflictEntry;
    const all = [forA, forB, summaryB, version, name];
    const catalog = { key: "capabilities", groups };
    // A member name on --field selects the group record of THAT entry only.
    expect(resolveCore.selectConflicts(all, { entityId: "cap-b", field: "contract", catalog }).selected).toEqual([forB]);
    expect(resolveCore.selectConflicts(all, { entityId: "cap-b", group: "verification", catalog }).selected).toEqual([forB]);
    expect(resolveCore.selectConflicts(all, { entityId: "cap-b", field: "summary", catalog }).selected).toEqual([summaryB]);
    expect(resolveCore.selectConflicts(all, { entityId: "cap-b", catalog }).selected).toEqual([forB, summaryB]);
    expect(resolveCore.selectConflicts(all, { field: "version", catalog }).selected).toEqual([version]);
    // An invariant record is never selected here, and no entry's record leaks to the document level.
    expect(() => resolveCore.selectConflicts(all, { field: "summary", catalog })).toThrow('No conflict found for field "summary" at the document level');
    expect(() => resolveCore.selectConflicts(all, { entityId: "cap-c", group: "verification", catalog })).toThrow('No "verification" group conflict found on entry "cap-c"');
  });
});

// ---------------------------------------------------------------------------

describe("T-529: resolve capabilities, the verification group", () => {
  async function groupFixture(): Promise<string> {
    const root = await project();
    const base = cap("cap-c");
    const ours = cap("cap-c", { contract: "Ours contract.", status: "review", pendingNote: "Owed: the docs." });
    const theirs = cap("cap-c", { checkedAt: AT_B });
    writeCaps(root, [cap("cap-a"), cap("cap-b"), { ...ours, summary: "Merged summary." }], [groupRecord(2, base, ours, theirs)]);
    return root;
  }

  it("--use theirs writes theirs' group whole: a member theirs lacks is deleted, fields outside the group untouched, and the file loads", async () => {
    const root = await groupFixture();
    const data = await resolved("capabilities", root, { entityId: "cap-c", group: "verification", use: "theirs" });
    expect(data).toMatchObject({ resolved: ["cap-c: verification"], remaining: 0, fullyResolved: true });
    const c = entry(capsOf(root), "cap-c");
    expect(c.contract).toBe("Contract of cap-c.");
    expect(c.checkedAt).toEqual(AT_B);
    expect(c.status).toBe("current");
    expect(Object.hasOwn(c, "pendingNote")).toBe(false);
    expect(c.summary).toBe("Merged summary.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
    expect(capabilityCatalog.load(root).doc.capabilities).toHaveLength(3);
    // Resolved means ordinary writes are allowed again.
    await expect(capabilityCatalog.mutate(root, (d) => d)).resolves.toBeDefined();
  });

  it("--use ours keeps the entry as merged and consumes the record", async () => {
    const root = await groupFixture();
    await resolved("capabilities", root, { entityId: "cap-c", group: "verification", use: "ours" });
    const c = entry(capsOf(root), "cap-c");
    expect(c.contract).toBe("Ours contract.");
    expect(c.pendingNote).toBe("Owed: the docs.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("an explicit null in the chosen side is written as null, and the schema then refuses the write: null is never read as delete", async () => {
    const root = await project();
    const ours = cap("cap-c", { pendingNote: "Owed." });
    const theirs = { ...groupOf(cap("cap-c")), pendingNote: null };
    writeCaps(root, [ours], [{ ...groupRecord(0, cap("cap-c"), ours, cap("cap-c")), theirs }]);
    await refused("capabilities", root, { entityId: "cap-c", group: "verification", use: "theirs" }, /refusing to write an invalid document/);
  });

  it("--field on a group member selects that entry's group record, whole", async () => {
    const root = await groupFixture();
    const data = await resolved("capabilities", root, { entityId: "cap-c", field: "contract", use: "theirs" });
    expect(data.resolved).toEqual(["cap-c: verification"]);
    const c = entry(capsOf(root), "cap-c");
    expect(c.checkedAt).toEqual(AT_B);
    expect(Object.hasOwn(c, "pendingNote")).toBe(false);
  });

  it("--value on a group is refused: a group is resolved whole", async () => {
    const root = await groupFixture();
    await refused("capabilities", root, { entityId: "cap-c", field: "contract", value: "Mine." }, /Cannot use --value on a coupled group/);
  });

  it("--group without --id is refused", async () => {
    const root = await groupFixture();
    await refused("capabilities", root, { group: "verification", use: "theirs" }, /--group needs --id/);
  });

  it("two conflicted capabilities: one entry's group never consumes the other's", async () => {
    const root = await project();
    const oursA = cap("cap-a", { contract: "A ours." });
    const oursB = cap("cap-b", { contract: "B ours." });
    writeCaps(root, [oursA, oursB], [
      groupRecord(0, cap("cap-a"), oursA, cap("cap-a", { checkedAt: AT_B })),
      groupRecord(1, cap("cap-b"), oursB, cap("cap-b", { checkedAt: AT_B })),
    ]);
    const data = await resolved("capabilities", root, { entityId: "cap-a", group: "verification", use: "theirs" });
    expect(data.remaining).toBe(1);
    expect(entry(capsOf(root), "cap-a").checkedAt).toEqual(AT_B);
    expect(entry(capsOf(root), "cap-b").contract).toBe("B ours.");
    expect((read(root, "capabilities.json")._conflicts as Rec[]).map((c) => c.entityId)).toEqual(["cap-b"]);
  });

  it("a carried record is applied to its entry where it is NOW, not at the index the merge recorded", async () => {
    const root = await project();
    const ours = cap("cap-c", { contract: "Ours." });
    // Recorded at index 0; two entries were inserted before it since.
    const summary = { fieldPath: "/capabilities/0/summary", field: "summary", kind: "field", entityId: "cap-c", base: "s0", ours: ours.summary, theirs: "Theirs summary." };
    writeCaps(root, [cap("cap-a"), cap("cap-b"), ours], [groupRecord(0, cap("cap-c"), ours, cap("cap-c", { checkedAt: AT_B })), summary]);
    await resolved("capabilities", root, { entityId: "cap-c", use: "theirs" });
    const list = capsOf(root);
    expect(entry(list, "cap-c")).toMatchObject({ summary: "Theirs summary.", checkedAt: AT_B, contract: "Contract of cap-c." });
    expect(entry(list, "cap-a")).toEqual(cap("cap-a"));
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("a chosen side carrying a key outside the group is refused as untrusted", async () => {
    const root = await groupFixture();
    const doc = read(root, "capabilities.json");
    (doc._conflicts as Rec[])[0]!.theirs = { ...groupOf(cap("cap-c")), summary: "smuggled" };
    writeFileSync(path(root, "capabilities.json"), JSON.stringify(doc, null, 2) + "\n");
    await refused("capabilities", root, { entityId: "cap-c", group: "verification", use: "theirs" }, /"summary", which is not a member of the group/);
  });

  it("a record naming an entry the file no longer has is refused", async () => {
    const root = await project();
    const ours = cap("cap-c");
    writeCaps(root, [cap("cap-a")], [groupRecord(0, ours, ours, cap("cap-c", { checkedAt: AT_B }))]);
    await refused("capabilities", root, { entityId: "cap-c", group: "verification", use: "theirs" }, /names entry "cap-c", which is not in capabilities\.json/);
  });

  it("a repeated --id or --group (yargs makes it an array) is refused", async () => {
    const root = await groupFixture();
    await refused("capabilities", root, { entityId: ["cap-c", "cap-a"], group: "verification", use: "theirs" }, /--id takes one value/);
    await refused("capabilities", root, { entityId: "cap-c", group: ["verification", "x"], use: "theirs" }, /--group takes one value/);
  });

  it("a clean catalog is not rewritten, and an absent one is not created", async () => {
    const root = await project();
    const absent = await resolved("glossary", root, { use: "theirs" });
    expect(absent).toMatchObject({ resolved: [], remaining: 0, fullyResolved: true });
    expect(existsSync(path(root, "glossary.json"))).toBe(false);
    writeCaps(root, [cap("cap-a")]);
    const before = bytes(root, "capabilities.json");
    const md = await run("capabilities", root, { use: "theirs", format: "md" });
    expect(md.output).toBe("capabilities.json has no conflicts.");
    expect(bytes(root, "capabilities.json")).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("T-529: resolve, whole-entry records and deletion", () => {
  function deleteEdit(key: "capabilities" | "terms", index: number, id: string, base: Rec, theirs: Rec): Rec {
    // ours deleted the entry, theirs edited it: `ours` is absent from the record.
    return { fieldPath: `/${key}/${index}`, field: `${key}[id=${id}]`, kind: "delete-edit", entityId: id, base, theirs };
  }

  it("a capability is never deleted by a resolution: the deleting side is refused, the editing side lands", async () => {
    const root = await project();
    const edited = cap("cap-b", { summary: "Theirs edit." });
    writeCaps(root, [cap("cap-a"), edited], [deleteEdit("capabilities", 1, "cap-b", cap("cap-b"), edited)]);
    await refused("capabilities", root, { entityId: "cap-b", use: "ours" }, /a resolution never deletes a capability/);
    await resolved("capabilities", root, { entityId: "cap-b", use: "theirs" });
    expect(entry(capsOf(root), "cap-b").summary).toBe("Theirs edit.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("a chosen whole entry whose id is not the record's entry is refused", async () => {
    const root = await project();
    const record = deleteEdit("capabilities", 1, "cap-b", cap("cap-b"), cap("cap-z"));
    writeCaps(root, [cap("cap-a"), cap("cap-b")], [record]);
    await refused("capabilities", root, { entityId: "cap-b", use: "theirs" }, /the chosen side is not that entry/);
  });

  it("a term deletion runs the reference guard: refused while a capability names it, allowed once nothing does", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a", { terms: ["term-b"] })]);
    const edited = term("term-b", "hands", { definition: "Edited." });
    writeTerms(root, [term("term-a", "pen"), edited], [deleteEdit("terms", 1, "term-b", term("term-b", "hands"), edited)]);
    await refused("glossary", root, { entityId: "term-b", use: "ours" }, /Cannot delete term "term-b" in this resolution: Term .*term-b.* is referenced by .*cap-a/);
    writeCaps(root, [cap("cap-a")]);
    await resolved("glossary", root, { entityId: "term-b", use: "ours" });
    expect(termsOf(root).map((t) => t.id)).toEqual(["term-a"]);
  });

  it("a term deletion on an unreadable inventory is refused", async () => {
    const root = await project();
    writeFileSync(path(root, "capabilities.json"), "{ not json");
    const edited = term("term-b", "hands", { definition: "Edited." });
    writeTerms(root, [term("term-a", "pen"), edited], [deleteEdit("terms", 1, "term-b", term("term-b", "hands"), edited)]);
    await refused("glossary", root, { entityId: "term-b", use: "ours" }, /capability inventory could not be read/);
  });

  it("a legacy record with no entry id resolves at its recorded path, and --id never selects it", async () => {
    const root = await project();
    const legacy = { fieldPath: "/capabilities/0/summary", field: "summary", kind: "field", base: "s0", ours: "Summary of cap-a.", theirs: "Legacy theirs." };
    writeCaps(root, [cap("cap-a")], [legacy]);
    await refused("capabilities", root, { entityId: "cap-a", use: "theirs" }, /No conflict found on entry "cap-a"/);
    await resolved("capabilities", root, { use: "theirs" });
    expect(entry(capsOf(root), "cap-a").summary).toBe("Legacy theirs.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("a whole-entry record whose alias names another entry is refused: the guarded entry is the deleted one", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a", { terms: ["term-b"] })]);
    const edited = term("term-a", "pen", { definition: "Edited." });
    // entityId says term-a (unreferenced, so the guard passes); the alias says term-b (referenced).
    const record = { fieldPath: "/terms/0", field: "terms[id=term-b]", kind: "delete-edit", entityId: "term-a", base: term("term-a", "pen"), theirs: edited };
    writeTerms(root, [edited, term("term-b", "hands")], [record]);
    await refused("glossary", root, { entityId: "term-a", use: "ours" }, /a path or alias that does not describe that entry/);
    await refused("glossary", root, { use: "ours" }, /a path or alias that does not describe that entry/);
  });

  it("an entry record whose path is not under that entry is refused, never applied where it points", async () => {
    const root = await project();
    const outside = { fieldPath: "/version", field: "version", kind: "field", entityId: "cap-a", base: 1, ours: 1, theirs: 1 };
    writeCaps(root, [cap("cap-a")], [outside]);
    await refused("capabilities", root, { entityId: "cap-a", use: "theirs" }, /a path or alias that does not describe that entry/);
    const ours = cap("cap-a");
    const deep = { ...groupRecord(0, ours, ours, cap("cap-a", { checkedAt: AT_B })), fieldPath: "/capabilities/0/contract" };
    writeCaps(root, [ours], [deep]);
    await refused("capabilities", root, { entityId: "cap-a", group: "verification", use: "theirs" }, /a path or alias that does not describe that entry/);
    // An entry field whose alias claims the whole document never replaces it.
    const snapshot = { version: 1, capabilities: [cap("cap-a", { summary: "Smuggled." })] };
    const posing = { fieldPath: "/capabilities/0/summary", field: "_entity", kind: "field", entityId: "cap-a", base: "s0", ours: ours.summary, theirs: snapshot };
    writeCaps(root, [ours, cap("cap-b")], [posing]);
    await refused("capabilities", root, { entityId: "cap-a", use: "theirs" }, /a path or alias that does not describe that entry/);
  });

  it("a whole-document record goes first: an entry record is applied to its entry in the document it leaves", async () => {
    const root = await project();
    const a = cap("cap-a");
    const b = cap("cap-b");
    // theirs' snapshot reverses the two entries; the carried record was recorded with cap-a at 0.
    const whole = { fieldPath: "", field: "_entity", kind: "field", base: {}, ours: { version: 1, capabilities: [a, b] }, theirs: { version: 1, capabilities: [b, a] } };
    const summary = { fieldPath: "/capabilities/0/summary", field: "summary", kind: "field", entityId: "cap-a", base: a.summary, ours: a.summary, theirs: "Theirs A." };
    writeCaps(root, [a, b], [whole, summary]);
    await resolved("capabilities", root, { use: "theirs" });
    const list = capsOf(root);
    expect(list.map((e) => e.id)).toEqual(["cap-b", "cap-a"]);
    expect(entry(list, "cap-a").summary).toBe("Theirs A.");
    expect(entry(list, "cap-b").summary).toBe("Summary of cap-b.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("a field deleted on one side and edited on the other resolves on its entry, found by id", async () => {
    const root = await project();
    const a = cap("cap-a", { example: "Base A." });
    const b = cap("cap-b", { example: "Base B." });
    // Recorded at index 1 (cap-b's slot now): ours deleted cap-a's example, theirs edited it.
    const record = { fieldPath: "/capabilities/1/example", field: "example", kind: "delete-edit", entityId: "cap-a", base: "Base A.", theirs: "Theirs A." };
    writeCaps(root, [a, b], [record]);
    await resolved("capabilities", root, { entityId: "cap-a", use: "ours" });
    expect(Object.hasOwn(entry(capsOf(root), "cap-a"), "example")).toBe(false);
    expect(entry(capsOf(root), "cap-b").example).toBe("Base B.");
  });
});

// ---------------------------------------------------------------------------

describe("T-529: resolve --invariant, the term-owner rule", () => {
  async function wordFixture(extraTerms: Rec[] = [], record = wordRecord("pen", ["term-a", "term-b"])): Promise<string> {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    writeTerms(root, [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen"), ...extraTerms], [record]);
    return root;
  }

  it("--rename on the claimant's term: the record is consumed and updatedAt is bumped", async () => {
    const root = await wordFixture();
    const data = await resolved("glossary", root, { invariant: 1, rename: ["term-b", "author"] });
    expect(data).toMatchObject({ resolved: ["invariant 1"], remaining: 0, fullyResolved: true });
    const b = entry(termsOf(root), "term-b");
    expect(b.term).toBe("author");
    expect(b.updatedAt).not.toBe(OLD_STAMP);
    expect(Number.isNaN(Date.parse(b.updatedAt as string))).toBe(false);
    expect(entry(termsOf(root), "term-a")).toEqual(term("term-a", "manager", { aliases: ["Pen"] }));
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
  });

  it("--rename on a claimant whose claim is an alias renames that alias", async () => {
    const root = await wordFixture();
    await resolved("glossary", root, { invariant: 1, rename: ["term-a", "Boss"] });
    const a = entry(termsOf(root), "term-a");
    expect(a.aliases).toEqual(["Boss"]);
    expect(a.term).toBe("manager");
    expect(a.updatedAt).not.toBe(OLD_STAMP);
  });

  it("--drop-alias removes the colliding alias (an emptied list is removed) and bumps updatedAt", async () => {
    const root = await wordFixture();
    await resolved("glossary", root, { invariant: 1, dropAlias: ["term-a", "Pen"] });
    const a = entry(termsOf(root), "term-a");
    expect(Object.hasOwn(a, "aliases")).toBe(false);
    expect(a.updatedAt).not.toBe(OLD_STAMP);
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
  });

  it("--drop-alias refuses an alias that is not the colliding word, and one the entry does not carry", async () => {
    const root = await wordFixture();
    await refused("glossary", root, { invariant: 1, dropAlias: ["term-a", "Boss"] }, /is not the colliding word "pen"/);
    await refused("glossary", root, { invariant: 1, dropAlias: ["term-b", "pen"] }, /is not an alias of "term-b"/);
  });

  it("--keep keeps one claimant and deletes the others, with the records that named them", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    const own = { fieldPath: "/terms/0/definition", field: "definition", kind: "field", entityId: "term-a", base: "d0", ours: "d1", theirs: "d2" };
    writeTerms(root, [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen")], [wordRecord("pen", ["term-a", "term-b"]), own]);
    const md = await run("glossary", root, { invariant: 1, keep: "term-b", format: "md" });
    expect(md.output).toContain("Deleted term-a; kept term-b.");
    expect(md.output).toContain("Dropped 1 record(s) that named the deleted term(s) term-a.");
    expect(termsOf(root).map((t) => t.id)).toEqual(["term-b"]);
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
  });

  it("--keep deletes only the entries that claim the word now: a recorded claimant renamed since is kept", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    // Recorded as a three-way claim; term-c has been renamed to "tier" since.
    writeTerms(root, [term("term-a", "pen"), term("term-b", "Pen"), term("term-c", "tier")], [wordRecord("pen", ["term-a", "term-b", "term-c"])]);
    const md = await run("glossary", root, { invariant: 1, keep: "term-a", format: "md" });
    expect(md.output).toContain("Deleted term-b; kept term-a.");
    expect(termsOf(root).map((t) => t.id)).toEqual(["term-a", "term-c"]);
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
  });

  it("--keep of a recorded claimant that no longer claims the word is refused", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    writeTerms(root, [term("term-a", "tier"), term("term-b", "pen"), term("term-c", "Pen")], [wordRecord("pen", ["term-a", "term-b", "term-c"])]);
    await refused("glossary", root, { invariant: 1, keep: "term-a" }, /"term-a" no longer claims "pen", so it cannot be the one kept/);
  });

  it("--keep is refused when the word now has a claimant the record does not name", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    // A second record covers the three-way claim, so the file loads; the first names only two of them.
    writeTerms(root, [term("term-a", "pen"), term("term-b", "Pen"), term("term-c", "PEN")], [
      wordRecord("pen", ["term-a", "term-b"]),
      wordRecord("pen", ["term-a", "term-b", "term-c"]),
    ]);
    await refused("glossary", root, { invariant: 1, keep: "term-a" }, /"pen" is now claimed by term-a, term-b, term-c, not only by the entries the record names/);
  });

  it("--keep runs the reference guard inside the lock: a referenced claimant is not deleted", async () => {
    const root = await wordFixture();
    writeCaps(root, [cap("cap-a", { terms: ["term-a"] })]);
    await refused("glossary", root, { invariant: 1, keep: "term-b" }, /Cannot delete term "term-a" in this resolution: .*referenced by .*cap-a/);
  });

  it("--keep on an unreadable inventory is refused", async () => {
    const root = await wordFixture();
    writeFileSync(path(root, "capabilities.json"), "{ not json");
    await refused("glossary", root, { invariant: 1, keep: "term-b" }, /capability inventory could not be read/);
  });

  it("an id the record does not name, and an ordinal out of range, are refused", async () => {
    const root = await wordFixture([term("term-c", "floor")]);
    await refused("glossary", root, { invariant: 1, rename: ["term-c", "x"] }, /Entry "term-c" is not named by invariant 1 \(it names term-a, term-b\)/);
    await refused("glossary", root, { invariant: 2, rename: ["term-b", "x"] }, /has no invariant conflict 2 \(it has 1\)/);
    await refused("glossary", root, { invariant: 0, rename: ["term-b", "x"] }, /has no invariant conflict 0/);
    await refused("glossary", root, { invariant: Number.NaN, rename: ["term-b", "x"] }, /has no invariant conflict NaN/);
  });

  it("a rename that still claims the word is refused", async () => {
    const root = await wordFixture();
    await refused("glossary", root, { invariant: 1, rename: ["term-b", " PEN "] }, /every entry invariant 1 names still claims "pen"/);
  });

  it("THE INCREMENTAL RULE: a rename onto a word another entry owns is refused and names the new collision", async () => {
    const root = await wordFixture([term("term-c", "writer")]);
    await refused("glossary", root, { invariant: 1, rename: ["term-b", "Writer"] }, /would add a collision glossary\.json does not have: term-owner "writer" \(term-b, term-c\)/);
  });

  it("D11: three claimants renamed one at a time: the record narrows, then goes", async () => {
    const root = await wordFixture(
      [term("term-c", "scribe", { aliases: ["PEN"] })],
      wordRecord("pen", ["term-a", "term-b", "term-c"]),
    );
    const first = await run("glossary", root, { invariant: 1, rename: ["term-b", "author"], format: "md" });
    expect(first.output).toContain('Invariant "pen" narrowed, 2 claimants remain: term-a, term-c.');
    expect(first.output).toContain("1 conflict(s) remaining.");
    expect(read(root, "glossary.json")._conflicts).toEqual([wordRecord("pen", ["term-a", "term-c"])]);
    // Still numbered 1 where `conflicts show` prints it.
    const show = await conflictsCmd.handleConflictsShow("glossary", root, "md");
    expect(show.output).toContain('### Invariant 1: term-owner "pen" [invariant]');
    expect(glossaryCatalog.load(root).doc.terms).toHaveLength(3);
    await resolved("glossary", root, { invariant: 1, rename: ["term-c", "Quill"] });
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
    expect(entry(termsOf(root), "term-c").aliases).toEqual(["Quill"]);
  });

  it("D11: in a three-way record, a rename onto a fourth entry's word is refused and named", async () => {
    const root = await wordFixture(
      [term("term-c", "scribe", { aliases: ["PEN"] }), term("term-d", "author")],
      wordRecord("pen", ["term-a", "term-b", "term-c"]),
    );
    await refused("glossary", root, { invariant: 1, rename: ["term-b", "Author"] }, /term-owner "author" \(term-b, term-d\)/);
  });

  it("THE INCREMENTAL RULE: a rename that joins another RECORDED collision is refused too: a new claimant is a new collision", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    writeTerms(
      root,
      [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen"), term("term-c", "floor"), term("term-d", "base", { aliases: ["Floor"] })],
      [wordRecord("pen", ["term-a", "term-b"]), wordRecord("floor", ["term-c", "term-d"])],
    );
    await refused("glossary", root, { invariant: 1, rename: ["term-b", "FLOOR"] }, /would add a collision glossary\.json does not have: term-owner "floor" \(term-b, term-c, term-d\)/);
  });

  it("an unrelated recorded collision stays covered and open", async () => {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    writeTerms(
      root,
      [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen"), term("term-c", "floor"), term("term-d", "base", { aliases: ["Floor"] })],
      [wordRecord("pen", ["term-a", "term-b"]), wordRecord("floor", ["term-c", "term-d"])],
    );
    const data = await resolved("glossary", root, { invariant: 1, rename: ["term-b", "author"] });
    expect(data.remaining).toBe(1);
    expect(read(root, "glossary.json")._conflicts).toEqual([wordRecord("floor", ["term-c", "term-d"])]);
  });
});

// ---------------------------------------------------------------------------

describe("T-529: resolve --invariant, the capability-name rule", () => {
  async function nameFixture(extra: Rec[] = []): Promise<string> {
    const root = await project();
    writeCaps(root, [cap("cap-a", { name: "Merge" }), cap("cap-b", { name: "merge " }), ...extra], [nameRecord("merge", ["cap-a", "cap-b"])]);
    return root;
  }

  it("--rename gives one capability another name and consumes the record", async () => {
    const root = await nameFixture();
    await resolved("capabilities", root, { invariant: 1, rename: ["cap-b", "Merge driver"] });
    expect(entry(capsOf(root), "cap-b").name).toBe("Merge driver");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });

  it("--keep and --drop-alias are refused: a capability is never deleted and has no aliases", async () => {
    const root = await nameFixture();
    await refused("capabilities", root, { invariant: 1, keep: "cap-a" }, /--keep applies to a word terms claim/);
    await refused("capabilities", root, { invariant: 1, dropAlias: ["cap-a", "Merge"] }, /--drop-alias applies to a word terms claim/);
  });

  it("a rename onto another capability's name is refused and named", async () => {
    const root = await nameFixture([cap("cap-c", { name: "Resolve" })]);
    await refused("capabilities", root, { invariant: 1, rename: ["cap-b", "resolve"] }, /capability-name "resolve" \(cap-b, cap-c\)/);
  });

  it("a record of the other catalog's rule is refused, not applied", async () => {
    const root = await project();
    // No name collision, so the file loads; the stray record is the resolver's to refuse.
    writeCaps(root, [cap("cap-a"), cap("cap-b")], [
      { fieldPath: "/capabilities", kind: "invariant", rule: "term-owner", key: "name cap-a", entityIds: ["cap-a", "cap-b"] },
    ]);
    await refused("capabilities", root, { invariant: 1, rename: ["cap-b", "Other"] }, /invariant 1 is a term-owner record, which does not belong in capabilities\.json/);
  });
});

// ---------------------------------------------------------------------------

describe("T-529: invariant records against field and group resolutions", () => {
  it("a bare --use applies every other record and leaves the invariant records open, with the instruction", async () => {
    const root = await project();
    const ours = cap("cap-c", { contract: "Ours." });
    writeCaps(root, [cap("cap-a", { name: "Merge" }), cap("cap-b", { name: "merge" }), ours], [
      nameRecord("merge", ["cap-a", "cap-b"]),
      groupRecord(2, cap("cap-c"), ours, cap("cap-c", { checkedAt: AT_B })),
    ]);
    const md = await run("capabilities", root, { use: "theirs", format: "md" });
    expect(md.output).toContain("Resolved 1 conflict(s) on capabilities.json.");
    expect(md.output).toContain("1 invariant conflict(s) stay open: resolve each with `storybloq resolve capabilities.json --invariant <n> ...`.");
    expect(md.output).toContain("1 conflict(s) remaining.");
    expect(read(root, "capabilities.json")._conflicts).toEqual([nameRecord("merge", ["cap-a", "cap-b"])]);
    await refused("capabilities", root, { use: "theirs" }, /has only invariant conflicts; resolve each with/);
  });

  it("THE INCREMENTAL RULE on a field resolution: a chosen value that creates a collision is refused and named", async () => {
    const root = await project();
    const record = { fieldPath: "/capabilities/1/name", field: "name", kind: "field", entityId: "cap-b", base: "Name cap-b", ours: "Name cap-b", theirs: "name CAP-A" };
    writeCaps(root, [cap("cap-a"), cap("cap-b")], [record]);
    await refused("capabilities", root, { entityId: "cap-b", field: "name", use: "theirs" }, /would add a collision capabilities\.json does not have: capability-name "name cap-a" \(cap-a, cap-b\)/);
  });

  it("a field resolution that removes a recorded collision consumes its invariant record", async () => {
    const root = await project();
    const record = { fieldPath: "/capabilities/1/name", field: "name", kind: "field", entityId: "cap-b", base: "Other", ours: "merge", theirs: "Other" };
    writeCaps(root, [cap("cap-a", { name: "Merge" }), cap("cap-b", { name: "merge" })], [nameRecord("merge", ["cap-a", "cap-b"]), record]);
    const md = await run("capabilities", root, { entityId: "cap-b", field: "name", use: "theirs", format: "md" });
    expect(md.output).toContain("1 invariant record(s) no longer describe a collision and were cleared.");
    expect(md.output).toContain("All conflicts resolved.");
    expect(read(root, "capabilities.json")._conflicts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("T-529: resolve flags", () => {
  async function wordRoot(): Promise<string> {
    const root = await project();
    writeCaps(root, [cap("cap-a")]);
    writeTerms(root, [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen")], [wordRecord("pen", ["term-a", "term-b"])]);
    return root;
  }

  it("an action without --invariant, --invariant with a side, two actions, and a one-value --rename are all refused", async () => {
    const root = await wordRoot();
    await refused("glossary", root, { rename: ["term-b", "x"] }, /name it with --invariant <n>/);
    await refused("glossary", root, { invariant: 1, use: "theirs" }, /--invariant <n> is resolved by changing entries/);
    await refused("glossary", root, { invariant: 1, rename: ["term-b", "x"], keep: "term-a" }, /takes exactly one of --rename/);
    await refused("glossary", root, { invariant: 1 }, /takes exactly one of --rename/);
    await refused("glossary", root, { invariant: 1, rename: ["term-b"] }, /--rename takes exactly two values/);
    await refused("glossary", root, { invariant: 1, keep: ["term-a", "term-b"] }, /--keep takes one value/);
  });

  it("a catalog-only flag on any other target is refused before anything is read", async () => {
    const root = await project();
    await expect(run("T-001", root, { entityId: "cap-a", use: "theirs" })).rejects.toThrow(/--id applies only to a catalog \(capabilities or glossary\), not to "T-001"/);
    await expect(run("config", root, { invariant: 1, keep: "x" })).rejects.toThrow(/--invariant, --keep apply only to a catalog/);
  });

  it("the file name and the short name are the same target", async () => {
    const root = await wordRoot();
    await resolved("glossary.json", root, { invariant: 1, rename: ["term-b", "author"] });
    expect(read(root, "glossary.json")._conflicts).toBeUndefined();
  });

  it("a refusal is sanitized: a control byte in a merged record, or in a flag, never reaches the terminal", async () => {
    const root = await project();
    const hostile = "cap-\u001b]0;x\u0007";
    // The entry id arrived with a teammate's branch; the refusal echoes it.
    const record = { fieldPath: "/capabilities/0/summary", field: "summary", kind: "field", entityId: hostile, base: "s0", ours: "s1", theirs: "s2" };
    writeCaps(root, [cap("cap-a")], [record]);
    const merged = await run("capabilities", root, { use: "theirs" }).then(() => null, (e: Error) => e);
    expect(merged?.message).toMatch(/names entry "cap-\?\]0;x\?", which is not in capabilities\.json/);
    expect(merged!.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    writeTerms(root, [term("term-a", "manager", { aliases: ["Pen"] }), term("term-b", "pen")], [wordRecord("pen", ["term-a", "term-b"])]);
    const typed = await run("glossary", root, { invariant: 1, rename: [hostile, "x"] }).then(() => null, (e: Error) => e);
    expect(typed?.message).toMatch(/Entry "cap-\?\]0;x\?" is not named by invariant 1/);
    expect(typed!.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
