/**
 * T-526 (plan 3.7): pending markers on capabilities and terms.
 *
 * A pending note is known work nobody has done yet. It forces the effective
 * status to `review`, it blocks a plain stamp, it is cleared only together
 * with a stamp (capabilities) or an explicit update (terms), and digests list
 * pending entries first with a count.
 *
 * Standalone temp repositories only (ISS-1220).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  capabilityCatalog,
  handleCapabilityAdd,
  handleCapabilityCheck,
  handleCapabilityDefer,
  handleCapabilityGet,
  handleCapabilityList,
} from "../../../src/cli/commands/capability.js";
import { handleTermAdd, handleTermDefer, handleTermList, handleTermUpdate, handleTermGet } from "../../../src/cli/commands/term.js";
import { glossaryCatalog, termDigest, checkTerms } from "../../../src/core/glossary.js";
import { checkCapabilities, effectiveStatus } from "../../../src/core/capability.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeIssue } from "../../core/test-factories.js";
import { TermSchema } from "../../../src/models/glossary.js";
import { hasPendingNote } from "../../../src/models/capability.js";
import type { CommandContext } from "../../../src/cli/run.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

async function newRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pending-"));
  roots.push(root);
  await initProject(root, { name: "Pending", type: "npm" });
  for (const rel of ["src/core/thing.ts", "src/core/other.ts"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "export const a = 1;\n");
  }
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function ctxFor(root: string, format: "md" | "json" = "md", state = makeState()): CommandContext {
  return { state, warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

const THING = { id: "cap-thing", name: "The thing", summary: "Does the thing.", entryPoints: ["src/core/thing.ts"], contract: "Returns the thing." };
const OTHER = { id: "cap-other", name: "The other", summary: "Does the other.", entryPoints: ["src/core/other.ts"], contract: "Returns the other." };

function stored(root: string, id: string) {
  return capabilityCatalog.load(root).doc.capabilities.find((c) => c.id === id)!;
}

describe("the model: a note is set only when it has content", () => {
  it("blank and absent notes are both unset", () => {
    expect(hasPendingNote({})).toBe(false);
    expect(hasPendingNote({ pendingNote: "   " })).toBe(false);
    expect(hasPendingNote({ pendingNote: "retire: gone" })).toBe(true);
  });

  it("the effective status is review whenever a note is set, whatever the checks say", () => {
    expect(effectiveStatus("current", [], true)).toBe("review");
    expect(effectiveStatus("current", [], false)).toBe("current");
  });
});

describe("capability defer", () => {
  it("sets the note and the stored review flag and touches nothing else", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    const before = stored(root, "cap-thing");
    const res = await handleCapabilityDefer({ id: "cap-thing", note: "entry point moves in T-9" }, "md", root, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);
    const after = stored(root, "cap-thing");
    expect(after.pendingNote).toBe("entry point moves in T-9");
    expect(after.status).toBe("review");
    const { pendingNote: _n, status: _s, ...restAfter } = after;
    const { status: _s0, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
  });

  it("works on an entry whose entry point was renamed away, without repairing it first (no structural check)", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    renameSync(join(root, "src/core/thing.ts"), join(root, "src/core/renamed.ts"));
    const res = await handleCapabilityDefer({ id: "cap-thing", note: "retire: thing.ts was renamed" }, "md", root, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);
    expect(stored(root, "cap-thing").pendingNote).toBe("retire: thing.ts was renamed");
    expect(stored(root, "cap-thing").entryPoints).toEqual(["src/core/thing.ts"]);
  });

  it("refuses an empty note, an unknown id without writing, and an --issue that does not exist", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await expect(handleCapabilityDefer({ id: "cap-thing", note: "  " }, "md", root, ctxFor(root))).rejects.toThrow(CliValidationError);
    const file = join(root, ".story", "capabilities.json");
    const bytes = readFileSync(file, "utf-8");
    const missing = await handleCapabilityDefer({ id: "cap-nope", note: "x" }, "md", root, ctxFor(root));
    expect(missing.errorCode).toBe("not_found");
    expect(readFileSync(file, "utf-8")).toBe(bytes);
    await expect(handleCapabilityDefer({ id: "cap-thing", note: "x", issue: "ISS-404" }, "md", root, ctxFor(root))).rejects.toThrow(/ISS-404 not found/);
  });

  it("an --issue that exists is named in the note", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    const state = makeState({ issues: [makeIssue({ id: "ISS-7" })] });
    await handleCapabilityDefer({ id: "cap-thing", note: "update the contract", issue: "ISS-7" }, "md", root, ctxFor(root, "md", state));
    expect(stored(root, "cap-thing").pendingNote).toBe("update the contract (follow-up ISS-7)");
  });
});

describe("capability check --stamp with a pending note", () => {
  it("a stamp alone is refused while a note is set, and nothing is written", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    const file = join(root, ".story", "capabilities.json");
    const bytes = readFileSync(file, "utf-8");
    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(res.output).toContain("Refused to stamp cap-thing");
    expect(res.output).toContain("a pending note is set (owed)");
    expect(readFileSync(file, "utf-8")).toBe(bytes);
  });

  it("--clear-pending clears the note and stamps in ONE write", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    const mutate = vi.spyOn(capabilityCatalog, "mutate");
    try {
      const res = await handleCapabilityCheck({ stamp: ["cap-thing"], clearPending: true }, "json", root, ctxFor(root, "json"));
      expect(JSON.parse(res.output).data.stamped).toEqual(["cap-thing"]);
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      mutate.mockRestore();
    }
    const after = stored(root, "cap-thing");
    expect("pendingNote" in after).toBe(false);
    expect(after.status).toBe("current");
    expect(after.checkedAt.sha).toBe(git(root, "rev-parse", "HEAD"));
  });

  it("--clear-pending on an entry whose stamp is refused keeps the note and writes nothing", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    unlinkSync(join(root, "src", "core", "thing.ts"));
    git(root, "commit", "-q", "-am", "entry point removed");
    const file = join(root, ".story", "capabilities.json");
    const bytes = readFileSync(file, "utf-8");
    const res = await handleCapabilityCheck({ stamp: ["cap-thing"], clearPending: true }, "json", root, ctxFor(root, "json"));
    const data = JSON.parse(res.output).data;
    expect(data.stamped).toEqual([]);
    expect(data.refused.map((r: { id: string }) => r.id)).toEqual(["cap-thing"]);
    expect(readFileSync(file, "utf-8")).toBe(bytes);
    expect(stored(root, "cap-thing").pendingNote).toBe("owed");
  });

  it("--clear-pending without a stamp is refused", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await expect(handleCapabilityCheck({ clearPending: true }, "md", root, ctxFor(root))).rejects.toThrow(/pass it with --stamp/);
  });

  it("--stamp-all stamps the unflagged entries and refuses only the pending one", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityAdd(OTHER, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    const res = await handleCapabilityCheck({ stampAll: true }, "json", root, ctxFor(root, "json"));
    const data = JSON.parse(res.output).data;
    expect(data.stamped).toEqual(["cap-other"]);
    expect(data.refused.map((r: { id: string }) => r.id)).toEqual(["cap-thing"]);
  });
});

describe("pending entries in reads", () => {
  it("the check reports the note and forces review", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    // Clear the stored flag by hand: the note alone must still force review.
    await capabilityCatalog.mutate(root, (d) => ({ ...d, capabilities: d.capabilities.map((c) => ({ ...c, status: "current" as const })) }));
    const report = await checkCapabilities(root, capabilityCatalog.load(root).doc.capabilities, null, {});
    expect(report.entries[0]!.effectiveStatus).toBe("review");
    expect(report.entries[0]!.pendingNote).toBe("owed");
  });

  it("list puts pending entries first and counts them, in markdown and JSON; get shows the note", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(OTHER, "md", root);
    await handleCapabilityAdd(THING, "md", root);
    await handleCapabilityDefer({ id: "cap-thing", note: "owed" }, "md", root, ctxFor(root));
    const json = JSON.parse((await handleCapabilityList({}, ctxFor(root, "json"))).output).data;
    expect(json.pending).toBe(1);
    expect(json.capabilities.map((c: { id: string }) => c.id)).toEqual(["cap-thing", "cap-other"]);
    const md = (await handleCapabilityList({}, ctxFor(root))).output;
    expect(md).toContain("# Capabilities (2 of 2, pending: 1)");
    expect(md.indexOf("cap-thing")).toBeLessThan(md.indexOf("cap-other"));
    expect(md).toContain("review: owed");
    expect((await handleCapabilityGet("cap-thing", {}, ctxFor(root))).output).toContain("- Pending: review: owed");
  });
});

describe("term defer and --clear-pending", () => {
  const T = { id: "term-duet", term: "duet", definition: "Two sessions paired on one repo." };

  it("defer sets only the note; update --clear-pending removes it; list and get show it", async () => {
    const root = await newRepo();
    await handleTermAdd(T, "md", root);
    const before = glossaryCatalog.load(root).doc.terms[0]!;
    await handleTermDefer({ id: "term-duet", note: "definition drifted in T-9" }, "md", root);
    const deferred = glossaryCatalog.load(root).doc.terms[0]!;
    expect(deferred).toEqual({ ...before, pendingNote: "definition drifted in T-9" });
    expect((await handleTermGet("term-duet", ctxFor(root))).output).toContain("- Pending: review: definition drifted in T-9");
    const md = (await handleTermList({}, ctxFor(root))).output;
    expect(md).toContain("pending: 1");
    expect(md).toContain("review: definition drifted in T-9");
    await handleTermUpdate({ id: "term-duet", clearPending: true }, "md", root);
    expect("pendingNote" in glossaryCatalog.load(root).doc.terms[0]!).toBe(false);
  });

  it("an update without --clear-pending keeps the note", async () => {
    const root = await newRepo();
    await handleTermAdd(T, "md", root);
    await handleTermDefer({ id: "term-duet", note: "owed" }, "md", root);
    await handleTermUpdate({ id: "term-duet", definition: "Two sessions, one pen and one worker." }, "md", root);
    expect(glossaryCatalog.load(root).doc.terms[0]!.pendingNote).toBe("owed");
  });

  it("defer refuses an unknown id without writing and an empty note", async () => {
    const root = await newRepo();
    await handleTermAdd(T, "md", root);
    const file = join(root, ".story", "glossary.json");
    const bytes = readFileSync(file, "utf-8");
    expect((await handleTermDefer({ id: "term-nope", note: "x" }, "md", root)).errorCode).toBe("not_found");
    expect(readFileSync(file, "utf-8")).toBe(bytes);
    await expect(handleTermDefer({ id: "term-duet", note: "" }, "md", root)).rejects.toThrow(CliValidationError);
  });
});

describe("term check and digest with pending notes", () => {
  function t(i: number, extra: Record<string, unknown> = {}) {
    return TermSchema.parse({ id: `term-${String(i).padStart(3, "0")}`, term: `word${String(i).padStart(3, "0")}`, definition: "d", updatedAt: "2026-09-20T00:00:00.000Z", ...extra });
  }

  it("a note forces review on the term check and is listed in pendingIds; thin alone does not", () => {
    const index = { capabilityIds: new Set<string>(), capabilityScanIncomplete: false, rulingIds: new Set<string>(), rulingScanIncomplete: false, rulingUnavailableIds: new Set<string>() };
    const report = checkTerms([t(1), t(2, { pendingNote: "owed" })], index);
    expect(report.entries.map((e) => e.effectiveStatus)).toEqual(["current", "review"]);
    expect(report.pendingIds).toEqual(["term-002"]);
    expect(report.entries[1]!.pendingNote).toBe("owed");
  });

  it("a pending NON-core term surfaces first even when the glossary is over the cap and only core loads", () => {
    const entries = [...Array.from({ length: 5 }, (_, i) => t(i, { core: true })), ...Array.from({ length: 10 }, (_, i) => t(100 + i))];
    entries.push(t(999, { pendingNote: "owed" }));
    const digest = termDigest(entries, 6);
    expect(digest.names[0]).toBe("word999");
    expect(digest.pending).toBe(1);
    expect(digest.returned).toBe(6);
    expect(digest.names.slice(1)).toEqual(["word000", "word001", "word002", "word003", "word004"]);
    expect(digest.omittedPending).toBe(0);
  });

  it("under the cap the pending entry still leads, and the markdown digest says so", async () => {
    const digest = termDigest([t(1), t(2, { pendingNote: "owed" })]);
    expect(digest.names).toEqual(["word002", "word001"]);
    const root = await newRepo();
    await handleTermAdd({ id: "term-a", term: "alpha", definition: "a" }, "md", root);
    await handleTermAdd({ id: "term-b", term: "beta", definition: "b" }, "md", root);
    await handleTermDefer({ id: "term-b", note: "owed" }, "md", root);
    const out = (await handleTermList({ digest: true }, ctxFor(root))).output;
    expect(out).toBe("Glossary: beta, alpha (pending: 1, listed first)");
    const json = JSON.parse((await handleTermList({ digest: true }, ctxFor(root, "json"))).output).data;
    expect(json.pending).toBe(1);
  });
});
