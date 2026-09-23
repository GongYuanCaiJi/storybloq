/**
 * T-526 P-3: the context manifest. Publication is immutable and verifiable,
 * the diff separates governing changes from incidental ones, recovery holds
 * the pointer on the authoritative pair, and a rebase invalidates any plan
 * approval that started before it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildContextBrief } from "../../src/autonomous/context-brief.js";
import {
  applyDiff,
  blocksCodeReview,
  clearOnApproval,
  CONTEXT_BRIEF_FILE,
  diffContextManifest,
  governingChangeGate,
  latestGeneration,
  MANIFEST_DIR,
  ManifestPublishError,
  manifestRef,
  markReviewStart,
  mustAddress,
  obligationLines,
  prepareContextForPlan,
  publishContextManifest,
  readContextManifests,
  readManifestPair,
  RebaseRefusal,
  rebaseContextManifest,
  suggestedFromCurrent,
  type ContextPointer,
} from "../../src/autonomous/context-manifest.js";
import { readSession, sessionDir, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { materialize } from "../../scripts/continuity-lib.js";
import { handleNodeLink } from "../../src/cli/commands/node.js";

const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const MAP = JSON.parse(readFileSync(join(FIXTURE, "fixture-map.json"), "utf-8")) as { rulings: Record<string, string> };
const R = MAP.rulings as { R1: string; R2: string; R3: string; R4: string; R5: string };
const SID = "00000000-0000-0000-0000-0000000000a1";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function copy(arm: 1 | 3 = 1): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "context-manifest-"));
  materialize(FIXTURE, arm, "T-2.a", root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (args: string[]): void => { execFileSync("git", args, { cwd: root, env, stdio: "ignore" }); };
  g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  roots.push(root);
  const dir = sessionDir(root, SID);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function rulingPath(root: string, id: string): string {
  return join(root, ".story", "rulings", `${id}.json`);
}

function editRuling(root: string, id: string, edit: (r: Record<string, unknown>) => Record<string, unknown>): void {
  const p = rulingPath(root, id);
  writeFileSync(p, JSON.stringify(edit(JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>), null, 2));
}

function addRuling(root: string, id: string, fields: Record<string, unknown>): void {
  const base = JSON.parse(readFileSync(rulingPath(root, R.R3), "utf-8")) as Record<string, unknown>;
  writeFileSync(rulingPath(root, id), JSON.stringify({ ...base, id, supersedes: null, ...fields }, null, 2));
}

const NEW_ID = "r-nnnnnnnnnnnnnnnn";

async function enter(root: string, dir: string, contextManifests?: unknown) {
  return prepareContextForPlan(root, dir, { contextManifests } as never, "T-2");
}

function makeSession(contextManifests: unknown): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SID, recipe: "coding", state: "PLAN", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false, frozenGate: { status: "ungated" },
    ticket: { id: "T-2", title: "Add logging for background jobs" },
    contextManifests,
  } as unknown as FullSessionState;
}

describe("publication", () => {
  it("writes the pair then the brief file; the json names itself and hashes its md", async () => {
    const { root, dir } = copy();
    const brief = await buildContextBrief(root, "T-2");
    const { name, manifest } = await publishContextManifest(dir, brief, { generation: 1, provisional: false });
    expect(name).toBe("T-2-1");
    const md = readFileSync(join(dir, MANIFEST_DIR, "T-2-1.md"), "utf-8");
    expect(md).toBe(brief.rendered);
    expect(createHash("sha256").update(md).digest("hex")).toBe(manifest.briefHash);
    expect(readFileSync(join(dir, CONTEXT_BRIEF_FILE), "utf-8")).toBe(brief.rendered);
    const read = readManifestPair(dir, "T-2-1");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.manifest.rulings.find((r) => r.id === R.R2)).toMatchObject({ tier: "suggested", delivered: true });
  });

  it("a published generation is immutable, and a half-written pair still claims its number", async () => {
    const { root, dir } = copy();
    const brief = await buildContextBrief(root, "T-2");
    await publishContextManifest(dir, brief, { generation: 1, provisional: false });
    await expect(publishContextManifest(dir, brief, { generation: 1, provisional: false })).rejects.toBeInstanceOf(ManifestPublishError);
    // The pair is written md then json, and the shared brief only after both.
    const order: string[] = [];
    const recording = async (path: string, content: string): Promise<void> => {
      order.push(path.slice(dir.length + 1));
      writeFileSync(path, content);
    };
    await publishContextManifest(dir, brief, { generation: 2, provisional: false, write: recording });
    expect(order).toEqual([`${MANIFEST_DIR}/T-2-2.md`, `${MANIFEST_DIR}/T-2-2.json`, CONTEXT_BRIEF_FILE]);
    // A failure at either pair step leaves the shared brief at the last complete generation.
    const sharedBefore = readFileSync(join(dir, CONTEXT_BRIEF_FILE), "utf-8");
    const edited = { ...brief, rendered: `${brief.rendered}\nchanged` };
    for (const [generation, failAt] of [[3, 1], [4, 2]] as const) {
      let calls = 0;
      const failing = async (path: string, content: string): Promise<void> => {
        if (++calls === failAt) throw new Error("disk full");
        writeFileSync(path, content);
      };
      await expect(publishContextManifest(dir, edited, { generation, provisional: false, write: failing })).rejects.toThrow("disk full");
      expect(readManifestPair(dir, `T-2-${generation}`).ok).toBe(false);
      expect(readFileSync(join(dir, CONTEXT_BRIEF_FILE), "utf-8")).toBe(sharedBefore);
    }
    expect(latestGeneration(dir, "T-2")).toBe(4);
  });

  it("an edited brief fails integrity by name", async () => {
    const { root, dir } = copy();
    await publishContextManifest(dir, await buildContextBrief(root, "T-2"), { generation: 1, provisional: false });
    writeFileSync(join(dir, MANIFEST_DIR, "T-2-1.md"), "tampered");
    const read = readManifestPair(dir, "T-2-1");
    expect(read).toEqual({ ok: false, reason: "manifest T-2-1 failed integrity: its brief does not match the recorded hash" });
  });
});

describe("the diff: governing versus incidental", () => {
  async function published(arm: 1 | 3 = 1) {
    const { root, dir } = copy(arm);
    const first = await enter(root, dir);
    expect(first.pointer?.current).toBe("T-2-1");
    return { root, dir, pointer: first.pointer! };
  }

  it("nothing changed: no obligation, no recovery", async () => {
    const { root, dir, pointer } = await published();
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff).toMatchObject({ integrity: true, governing: [], unverifiable: [] });
  });

  it("a delivered suggestion superseded mid-session is governing and names its successor", async () => {
    const { root, dir, pointer } = await published();
    addRuling(root, NEW_ID, { scopeTags: ["logging", "jobs"], date: "2026-09-20", text: "Owner: jobs log under the enqueuing request id, now also on retries.", supersedes: R.R2, createdAt: "2026-09-20T09:00:00.000Z" });
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff.governing).toContainEqual({ id: R.R2, kind: "superseded", from: R.R2, to: NEW_ID });
  });

  it("a revised ruling text is governing with both digests", async () => {
    const { root, dir, pointer } = await published();
    editRuling(root, R.R2, (r) => ({ ...r, text: `${r.text as string} Revised.` }));
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    const ob = diff.governing.find((g) => g.id === R.R2)!;
    expect(ob.kind).toBe("revised");
    expect(ob.from).toMatch(/^digest [0-9a-f]{12}$/);
    expect(ob.to).not.toBe(ob.from);
  });

  it("a withdrawn ruling is governing", async () => {
    const { root, dir, pointer } = await published();
    editRuling(root, R.R2, (r) => ({ ...r, status: "withdrawn" }));
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff.governing).toContainEqual(expect.objectContaining({ id: R.R2, kind: "withdrawn", to: "withdrawn" }));
  });

  it("a newly accepted ruling the item's keys reach is governing", async () => {
    const { root, dir, pointer } = await published();
    addRuling(root, NEW_ID, { scopeTags: ["jobs"], date: "2026-09-21", text: "Owner: every job logs its attempt number.", createdAt: "2026-09-21T09:00:00.000Z" });
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff.governing).toContainEqual({ id: NEW_ID, kind: "newly-accepted", from: "absent", to: "accepted" });
  });

  it("a citation already superseded when the pair was published is not raised again; a new successor is", async () => {
    const { root, dir } = copy();
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R.R5] }, null, 2));
    const { pointer } = await enter(root, dir);
    expect(await diffContextManifest(root, dir, pointer!, "T-2")).toMatchObject({ governing: [], unverifiable: [] });
    addRuling(root, NEW_ID, { scopeTags: ["logging"], date: "2026-09-21", createdAt: "2026-09-21T09:00:00.000Z", text: "Owner: logging redacts on every path, request ids included.", supersedes: R.R1 });
    expect((await diffContextManifest(root, dir, pointer!, "T-2")).governing).toContainEqual({ id: R.R5, kind: "superseded", from: R.R5, to: NEW_ID });
  });

  it("the review packet's suggestions are the delivered ones only", async () => {
    const { root, dir } = copy();
    for (let i = 1; i <= 7; i++) {
      addRuling(root, `r-cap000000000000${i}`, { scopeTags: ["jobs"], date: `2026-09-1${i}`, createdAt: `2026-09-1${i}T09:00:00.000Z`, text: `Owner: jobs rule ${i}.` });
    }
    const { pointer } = await enter(root, dir);
    const read = readManifestPair(dir, pointer!.current);
    if (!read.ok) throw new Error(read.reason);
    const delivered = read.manifest.rulings.filter((r) => r.tier === "suggested" && r.delivered).map((r) => r.id);
    expect(read.manifest.rulings.some((r) => r.tier === "suggested" && !r.delivered)).toBe(true);
    expect(suggestedFromCurrent(dir, pointer!).map((x) => x.id)).toEqual(delivered);
  });

  it("a suggestion the cap kept out of the brief governs nothing; the same change to a delivered one does", async () => {
    const { root, dir } = copy();
    for (let i = 1; i <= 7; i++) {
      addRuling(root, `r-cap000000000000${i}`, { scopeTags: ["jobs"], date: `2026-09-1${i}`, createdAt: `2026-09-1${i}T09:00:00.000Z`, text: `Owner: jobs rule ${i}.` });
    }
    const { pointer } = await enter(root, dir);
    const read = readManifestPair(dir, pointer!.current);
    if (!read.ok) throw new Error(read.reason);
    const omitted = read.manifest.rulings.filter((r) => r.tier === "suggested" && !r.delivered).map((r) => r.id);
    const delivered = read.manifest.rulings.filter((r) => r.tier === "suggested" && r.delivered).map((r) => r.id);
    expect(omitted.length).toBeGreaterThan(0);
    expect(pointer!.governingIds).not.toContain(omitted[0]);
    editRuling(root, omitted[0]!, (r) => ({ ...r, status: "withdrawn" }));
    expect(await diffContextManifest(root, dir, pointer!, "T-2")).toMatchObject({ governing: [], unverifiable: [] });
    editRuling(root, delivered[0]!, (r) => ({ ...r, status: "withdrawn" }));
    expect((await diffContextManifest(root, dir, pointer!, "T-2")).governing).toContainEqual(expect.objectContaining({ id: delivered[0], kind: "withdrawn" }));
  });

  it("an unrelated ruling change is not governing, and a catalog change is only incidental", async () => {
    const { root, dir, pointer } = await published(3);
    editRuling(root, R.R3, (r) => ({ ...r, text: `${r.text as string} Revised.` }));
    const capPath = join(root, ".story", "capabilities.json");
    const doc = JSON.parse(readFileSync(capPath, "utf-8")) as { capabilities: Record<string, unknown>[] };
    doc.capabilities = doc.capabilities.map((c) => (c.id === "cap-logging" ? { ...c, summary: `${c.summary as string} Edited.` } : c));
    writeFileSync(capPath, JSON.stringify(doc, null, 2));
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff.governing).toEqual([]);
    expect(diff.incidental.capabilities).toEqual(["cap-logging"]);
  });

  it("a governing ruling that can no longer be resolved sets recovery, which blocks code review", async () => {
    const { root, dir, pointer } = await published();
    unlinkSync(rulingPath(root, R.R2));
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    expect(diff.unverifiable).toEqual([R.R2]);
    const next = applyDiff(pointer, diff, "2026-09-22T00:00:00.000Z");
    expect(next.recovery?.reasons).toEqual([`governing ruling(s) could not be resolved: ${R.R2}`]);
    expect(blocksCodeReview(next)).toBe(true);
    expect(obligationLines(next).at(-1)).toMatch(/^recovery required: .*storybloq brief --rebase <sessionId> <item> --reason "<why>"/);
  });

  it("obligations accumulate once per target and must be named", async () => {
    const { root, dir, pointer } = await published();
    editRuling(root, R.R2, (r) => ({ ...r, status: "withdrawn" }));
    const diff = await diffContextManifest(root, dir, pointer, "T-2");
    const once = applyDiff(pointer, diff, "2026-09-22T00:00:00.000Z");
    const twice = applyDiff(once, diff, "2026-09-22T01:00:00.000Z");
    expect(twice.outstanding).toHaveLength(once.outstanding.length);
    expect(mustAddress(twice)).toEqual([R.R2]);
    expect(obligationLines(twice)[0]).toBe(`governing context changed: ${R.R2} withdrawn accepted-legacy to withdrawn; assess impact before continuing`);
  });
});

describe("the gate and PLAN entry", () => {
  it("each entry publishes the next generation and moves the pointer; obligations survive the move", async () => {
    const { root, dir } = copy();
    const first = await enter(root, dir);
    editRuling(root, R.R2, (r) => ({ ...r, status: "withdrawn" }));
    const second = await enter(root, dir, first.contextManifests);
    expect(second.pointer?.current).toBe("T-2-2");
    expect(mustAddress(second.pointer)).toEqual([R.R2]);
    expect(second.preamble[0]).toMatch(/^governing context changed: /);
  });

  it("while recovery is set, entry publishes a provisional pair and the pointer stays on the authoritative one", async () => {
    const { root, dir } = copy();
    const first = await enter(root, dir);
    writeFileSync(join(dir, MANIFEST_DIR, "T-2-1.md"), "tampered");
    const second = await enter(root, dir, first.contextManifests);
    expect(second.pointer?.current).toBe("T-2-1");
    expect(second.pointer?.recovery).not.toBeNull();
    const provisional = readManifestPair(dir, "T-2-2");
    expect(provisional.ok && provisional.manifest.provisional).toBe(true);
  });

  it("an unreadable pointer map is reported, never replaced", async () => {
    const { root, dir } = copy();
    expect(readContextManifests({ "T-2": { current: 7 } }).ok).toBe(false);
    const res = await enter(root, dir, { "T-2": { current: 7 } });
    expect(res.contextManifests).toBeNull();
    expect(res.preamble[0]).toMatch(/^recovery required: state\.contextManifests is malformed/);
    const gate = await governingChangeGate(root, dir, { contextManifests: { "T-2": { current: 7 } } } as never, "T-2");
    expect(gate.unreadable).not.toBeNull();
  });
});

describe("rebase and approval", () => {
  async function inRecovery() {
    const { root, dir } = copy();
    const first = await enter(root, dir);
    writeFileSync(join(dir, MANIFEST_DIR, "T-2-1.md"), "tampered");
    const second = await enter(root, dir, first.contextManifests);
    writeSessionSync(dir, makeSession(second.contextManifests));
    return { root, dir, pointer: second.pointer! };
  }

  it("refuses without a reason, and without a provisional pair to adopt", async () => {
    const { root, dir } = copy();
    const first = await enter(root, dir);
    writeSessionSync(dir, makeSession(first.contextManifests));
    await expect(rebaseContextManifest(root, SID, "T-2", " ", "tester")).rejects.toBeInstanceOf(RebaseRefusal);
    await expect(rebaseContextManifest(root, SID, "T-2", "adopting", "tester")).rejects.toThrow("no provisional manifest newer than T-2-1");
  });

  it("refuses when the governing set is unknown", async () => {
    const { root, dir, pointer } = await inRecovery();
    const { governingIds: _drop, ...legacy } = pointer;
    writeSessionSync(dir, makeSession({ "T-2": legacy }));
    await expect(rebaseContextManifest(root, SID, "T-2", "adopting", "tester")).rejects.toThrow("governing set unknown; repair the manifest file");
  });

  it("refuses while a governing ruling cannot be resolved, naming it", async () => {
    const { root } = await inRecovery();
    unlinkSync(rulingPath(root, R.R2));
    await expect(rebaseContextManifest(root, SID, "T-2", "adopting", "tester")).rejects.toThrow(`these governing rulings cannot be resolved now: ${R.R2}`);
  });

  it("adopts the provisional pair, records who and why, and invalidates plan approval with a fresh token", async () => {
    const { root, dir } = await inRecovery();
    const next = await rebaseContextManifest(root, SID, "T-2", "tampered md restored by hand", "tester");
    expect(next.current).toBe("T-2-2");
    expect(next.recovery).toBeNull();
    expect(next.rebased).toMatchObject({ by: "tester", reason: "tampered md restored by hand", from: "T-2-1" });
    expect(next.planApprovalInvalidated?.minGeneration).toBe(2);
    const stored = readContextManifests((readSession(dir) as { contextManifests?: unknown }).contextManifests);
    expect(stored.ok && stored.map["T-2"]?.current).toBe("T-2-2");
    expect(blocksCodeReview(next)).toBe(true);
  });

  it("an approval clears the invalidation only when its round started under the current token", async () => {
    const { root } = await inRecovery();
    const rebased = await rebaseContextManifest(root, SID, "T-2", "restored", "tester");
    const ref = manifestRef(rebased.current);
    // A round that started before the rebase carries the old (null) token.
    const stale: ContextPointer = { ...rebased, reviewToken: null, reviewRef: ref };
    expect(clearOnApproval(stale, ref).planApprovalInvalidated).not.toBeNull();
    // A round that started under an earlier rebase carries a different, non-null token.
    const earlier: ContextPointer = { ...rebased, reviewToken: `${rebased.planApprovalInvalidated!.token}-earlier`, reviewRef: ref };
    const kept = clearOnApproval(earlier, ref);
    expect(kept.planApprovalInvalidated).toEqual(rebased.planApprovalInvalidated);
    expect(blocksCodeReview(kept)).toBe(true);
    // A round started after it reads the new token and clears it.
    const fresh = markReviewStart(rebased, ref);
    const cleared = clearOnApproval(fresh, fresh.reviewRef ?? null);
    expect(cleared.planApprovalInvalidated).toBeNull();
    expect(blocksCodeReview(cleared)).toBe(false);
    // A packet that named a different pair clears nothing.
    expect(clearOnApproval(fresh, manifestRef("T-2-1"))).toBe(fresh);
  });
});

describe("no pointer is the legacy case", () => {
  it("the gate reports nothing and changes nothing", async () => {
    const { root, dir } = copy();
    const gate = await governingChangeGate(root, dir, {} as never, "T-2");
    expect(gate).toMatchObject({ pointer: null, unreadable: null, changed: false });
    expect(existsSync(join(dir, MANIFEST_DIR))).toBe(false);
  });
});

describe("a node citing its orchestrator's ruling (T-520)", () => {
  const R_X = "r-0123456789abcdef";

  /** The continuity node, linked to an orchestrator board that holds R_X; T-2 cites R_X. */
  async function linked(): Promise<{ root: string; dir: string; orch: string }> {
    const { root, dir } = copy();
    const orch = mkdtempSync(join(tmpdir(), "context-manifest-orch-"));
    roots.push(orch);
    for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "rulings"]) mkdirSync(join(orch, ".story", sub), { recursive: true });
    writeFileSync(join(orch, ".story", "config.json"), JSON.stringify({
      version: 2, schemaVersion: 1, project: "orch", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(orch, ".story", "roadmap.json"), JSON.stringify({ title: "orch", date: "2026-09-22", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "t" }], blockers: [] }));
    const base = JSON.parse(readFileSync(rulingPath(root, R.R3), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(orch, ".story", "rulings", `${R_X}.json`), JSON.stringify({ ...base, id: R_X, supersedes: null, scopeTags: [], text: "Orchestrator: every node logs through the shared logger." }, null, 2));
    expect((await handleNodeLink({ orchestrator: orch }, "json", root)).exitCode ?? 0).toBe(0);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R_X] }, null, 2));
    return { root, dir, orch };
  }

  it("the manifest records the binding's digest and lifecycle from the board that holds it", async () => {
    const { root, dir } = await linked();
    const first = await enter(root, dir);
    const read = readManifestPair(dir, first.pointer!.current);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const binding = read.manifest.rulings.find((r) => r.id === R_X)!;
    expect(binding.tier).toBe("binding");
    expect(binding.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.lifecycle).not.toBeNull();
  });

  it("an unchanged orchestrator citation stays clear; a revision on that board is an obligation", async () => {
    const { root, dir, orch } = await linked();
    const { pointer } = await enter(root, dir);
    expect(await diffContextManifest(root, dir, pointer!, "T-2")).toMatchObject({ integrity: true, governing: [], unverifiable: [] });
    const p = join(orch, ".story", "rulings", `${R_X}.json`);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf-8")), text: "Orchestrator: every node logs through the shared logger, with request ids." }, null, 2));
    const diff = await diffContextManifest(root, dir, pointer!, "T-2");
    expect(diff.unverifiable).toEqual([]);
    expect(diff.governing).toContainEqual(expect.objectContaining({ id: R_X, kind: "revised" }));
  });
});
