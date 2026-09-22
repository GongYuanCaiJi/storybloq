/**
 * T-525: the continuity deterministic suite. Cases assert structure through
 * the REAL path (F-B): the validate handler, the citation packet, the guide's
 * own PLAN instruction. Cases whose feature has not landed are named here as
 * todo with the owning ticket; that ticket records the RED evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProject } from "../../src/core/project-loader.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { handleExport } from "../../src/cli/commands/export.js";
import { citationsForReviewTarget } from "../../src/autonomous/cited-rulings.js";
import { guardPlanNamesCitedRulings } from "../../src/autonomous/plan-pin-guard.js";
import { loadRulingsSafe } from "../../src/core/ruling-loader.js";
import { buildSuccessorIndex, buildCitationResolutionContext, resolveCitation } from "../../src/core/ruling.js";
import { classifyLifecycle, payloadDigest } from "../../src/core/ruling-lifecycle.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { RulingSchema } from "../../src/models/ruling.js";
import { handleRulingAccept, handleRulingGet, handleRulingList, handleRulingPropose } from "../../src/cli/commands/ruling.js";
import * as oracle from "../core/oracle-1-15/ruling-655b03bf.js";
import { RulingSchema as OldRulingSchema } from "../core/oracle-1-15/ruling-schema-655b03bf.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import type { CommandContext } from "../../src/cli/types.js";
import { materialize, hashTree, TASKS } from "../../scripts/continuity-lib.js";
import { killSidecarsInRoot } from "../autonomous/_sidecar-cleanup.js";

const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const MAP = JSON.parse(readFileSync(join(FIXTURE, "fixture-map.json"), "utf-8")) as { rulings: Record<string, string> };
const FACTS = JSON.parse(readFileSync(join(FIXTURE, "facts.json"), "utf-8")) as { facts: { id: string; text: string; carriers: Record<string, string[]> }[]; arm2MustNotContain: string[] };

const roots: string[] = [];
function copy(arm: 1 | 2 | 3, task: (typeof TASKS)[number] = "T-2.a", git = false): string {
  const dest = mkdtempSync(join(tmpdir(), "continuity-e2e-"));
  materialize(FIXTURE, arm, task, dest);
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (args: string[]): void => { execFileSync("git", args, { cwd: dest, env, stdio: "ignore" }); };
    g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  }
  roots.push(dest);
  return dest;
}
afterEach(() => { for (const r of roots.splice(0)) { killSidecarsInRoot(r); rmSync(r, { recursive: true, force: true }); } });

/** Copies overlays/lifecycle/.story (R4, the proposal against R1) over a materialised core. */
function withLifecycle(root: string): string {
  cpSync(join(FIXTURE, "overlays", "lifecycle", ".story"), join(root, ".story"), { recursive: true });
  return root;
}
const CALLER = "continuity-suite";

async function ctxFor(root: string): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" };
}

describe("continuity case 0: fixture", () => {
  it("0a the core validates clean through the real validate handler", async () => {
    const out = handleValidate(await ctxFor(copy(1))).output;
    expect(out).toMatch(/Errors: 0/);
    expect(out).not.toMatch(/ERROR/);
  });

  it("0b every behavioural fact is carried in every arm; arm 2 has no catalogs (P-1)", () => {
    const arm2 = copy(2);
    for (const f of FACTS.arm2MustNotContain) expect(existsSync(join(arm2, f))).toBe(false);
    // Arm 3's catalogs land with T-523/T-524. Until the overlay carries a .story, it is a README placeholder and
    // arm 3 is not asserted; the moment it exists, every declared arm-3 carrier is checked like the others.
    const overlayLanded = existsSync(join(FIXTURE, "overlays", "arm3", ".story"));
    if (!overlayLanded) expect(existsSync(join(FIXTURE, "overlays", "arm3", "README.md"))).toBe(true);
    const arms: readonly (1 | 2 | 3)[] = overlayLanded ? [1, 2, 3] : [1, 2];
    for (const arm of arms) {
      const root = arm === 2 ? arm2 : copy(arm);
      for (const fact of FACTS.facts) {
        const carriers = fact.carriers[`arm${arm}`] ?? [];
        expect(carriers.length, `${fact.id} has no arm ${arm} carrier`).toBeGreaterThan(0);
        for (const carrier of carriers) {
          expect(existsSync(join(root, carrier)), `${carrier} exists in arm ${arm}`).toBe(true);
          expect(readFileSync(join(root, carrier), "utf-8"), `${fact.id} in ${carrier} (arm ${arm})`).toContain(fact.text);
        }
      }
    }
  });

  it("0c the materialised working copy is the core plus the variant, nothing else", () => {
    const dest = copy(1, "T-2.b");
    const core = hashTree(join(FIXTURE, "core"));
    const made = hashTree(dest);
    expect(made.files).toEqual(core.files);
    const differing = core.files.filter((f) => !readFileSync(join(FIXTURE, "core", f)).equals(readFileSync(join(dest, f))));
    expect(differing).toEqual([".story/tickets/T-2.json"]);
    const t2 = JSON.parse(readFileSync(join(dest, ".story/tickets/T-2.json"), "utf-8")) as { description: string };
    expect(t2.description).not.toMatch(/src\//);
  });
});

describe("continuity cases 4 and 5: compatibility (green today, pinned)", () => {
  it("4 a citation of the superseded R5 resolves forward to R1 with R1's wording through the packet path", async () => {
    const root = copy(1);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [MAP.rulings.R5] }, null, 2));
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.citations).toHaveLength(1);
    const c = res.citations[0]!;
    expect(c.status).toBe("resolved");
    if (c.status !== "resolved") return;
    expect(c.citedId).toBe(MAP.rulings.R5);
    expect(c.stale).toBe(true);
    expect(c.current.id).toBe(MAP.rulings.R1);
    expect(c.chain).toEqual([MAP.rulings.R5, MAP.rulings.R1]);
    expect(c.current.text).toContain("Logging keeps redaction and request ids on every path");
    expect(c.current.text).not.toContain("every line has the request id on it");
  });

  it("5 the unrelated ruling R3 reaches neither the PLAN instruction nor the context digest", async () => {
    const root = copy(1, "T-2.a", true);
    const result = await handleAutonomousGuide(root, { sessionId: null, action: "start", mode: "plan", ticketId: "T-2" } as never);
    const text = (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    expect(text).toMatch(/\*\*State:\*\*\s*PLAN/);
    expect(text).not.toContain(MAP.rulings.R3);
    expect(text).not.toContain("integer cents");
    const sid = /\*\*Session:\*\*\s*([0-9a-f-]{36})/i.exec(text)?.[1];
    expect(sid).toBeTruthy();
    const digest = join(root, ".story", "sessions", sid!, "context-digest.md");
    expect(existsSync(digest)).toBe(true);
    const d = readFileSync(digest, "utf-8");
    expect(d).not.toContain(MAP.rulings.R3);
    expect(d).not.toContain("integer cents");
  });
});

describe("continuity cases owned by later 1.16.0 tickets (RED evidence recorded by each owner)", () => {
  it.todo("1 delivery tiers: T-2 (a) brief has no binding, suggested R1 and R2 by scopeTag logging, R3 absent (T-526; entry: the guide's PLAN instruction / brief file)");
  it.todo("2 discovery then citation: R2 suggested, then cited via ticket update, then binding in the packet and enforced by the plan-pin guard (T-526; entry: brief, packet, plan-pin-guard)");
  it.todo("6 no-path variant (b) delivers cap-logging by title-word match with the no-paths-named disclosure (T-523 + T-526)");
  it.todo("7 EXISTING gate: a plan without the EXISTING line is retried (T-526; entry: PLAN report)");
  it.todo("7n EXISTING negative: a grep transcript in the EXISTING line is a plan-review finding; asserts the reviewer prompt line (T-526; entry: PLAN_REVIEW instruction text)");
  it.todo("8 completion: T-3 move marks cap-logging review at FINALIZE; a report without knowledgeImpact is retried; stale-reference advances and lands in the handover (T-527)");
  it.todo("9 arm 2 subset: with the capability file removed, cases 1 to 5 and 7 pass and the disclosure says no capability inventory (T-526)");
  it.todo("14 context manifest change detection on resume, replan and CODE_REVIEW entry (T-526 P-3)");
  it.todo("15 second-handoff maintenance: a disposition per impact, follow-up durable across a second session (T-527 P-1/P-2)");
});

describe("continuity cases 3 and 10 to 13: ruling lifecycle (T-522)", () => {
  const R1 = MAP.rulings.R1;
  const R4 = MAP.rulings.R4;

  it("3 proposed not binding: R4 renders under Proposed, the guard ignores it, R1 stays current, no successor index entry for R1", async () => {
    const root = withLifecycle(copy(1));
    const { rulings, lifecycleById, unavailableIds } = loadRulingsSafe(root);
    expect(lifecycleById.get(R4)).toBe("proposed");
    expect(lifecycleById.get(R1)).toBe("accepted-legacy");
    expect(unavailableIds.size).toBe(0);
    const index = buildSuccessorIndex(rulings);
    expect(index.successorsByTarget.get(R1)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(R1)).toBeUndefined();
    const ctx = buildCitationResolutionContext(rulings, unavailableIds, "complete", false);
    expect(resolveCitation(R1, ctx)).toMatchObject({ status: "resolved", stale: false, current: { id: R1 } });
    // Delivery: the proposal reaches the item beside its citations, never among them.
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.proposals.map((p) => p.id)).toEqual([R4]);
    expect(res.citations.map((c) => c.citedId)).not.toContain(R4);
    // The guard does not demand the plan name R4; it names it as not enforced.
    const verdict = await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNothing about rulings.");
    expect(verdict).toEqual({ ok: true, note: `Proposals against this item (not enforced): ${R4}` });
    // The Decisions listing files R4 under Proposed, R1 under Accepted.
    const md = handleRulingList({}, await ctxFor(root)).output;
    const proposedAt = md.indexOf("## Proposed (not binding)");
    expect(proposedAt).toBeGreaterThan(md.indexOf("## Accepted"));
    expect(md.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(proposedAt);
    expect(md).toContain(`Proposals against this ruling (not binding): ${R4}`);
  });

  it("10x export half of case 10: the Decisions section renders R4 under Proposed in both scopes; a phase export follows T-2's citation of R5 forward to R1", async () => {
    const root = withLifecycle(copy(1));
    const all = handleExport(await ctxFor(root), "all", null).output;
    const decisionsAt = all.indexOf("## Decisions (");
    expect(decisionsAt).toBeGreaterThan(-1);
    const proposedAt = all.indexOf("## Proposed (not binding)", decisionsAt);
    expect(proposedAt).toBeGreaterThan(all.indexOf("## Accepted", decisionsAt));
    expect(all.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(proposedAt);
    // A proposal for nobody: in the all export, absent from p1 (proposal filtering is per phase item).
    const q = JSON.parse((await handleRulingPropose({ text: "Q for nobody", attribution: "owner-direct", date: "2026-09-22", scopeTags: [], clientTaskId: CALLER }, "json", root)).output).data.id as string;
    expect(handleExport(await ctxFor(root), "all", null).output).toContain(`### ${q} [proposed]`);
    // Phase p1 holds T-1 (cites R1) and T-2 (R4 is proposed for it, cites nothing): R4 and R1 export, R5 and Q do not.
    const phase = handleExport(await ctxFor(root), "phase", "p1").output;
    const phaseProposedAt = phase.indexOf("## Proposed (not binding)");
    expect(phaseProposedAt).toBeGreaterThan(phase.indexOf("## Decisions ("));
    expect(phase.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(phaseProposedAt);
    expect(phase).toContain(`### ${R1} [accepted-legacy]`);
    expect(phase).not.toContain(`### ${MAP.rulings.R5}`);
    expect(phase).not.toContain(q);
    // T-1 stops citing R1, R4 stops proposing against it, and T-2 cites the superseded R5: R1 can now only arrive by forward traversal from R5, and each appears once.
    const r4Path = join(root, ".story", "rulings", `${R4}.json`);
    writeFileSync(r4Path, JSON.stringify({ ...JSON.parse(readFileSync(r4Path, "utf-8")), proposesToSupersede: null }, null, 2));
    const t1 = join(root, ".story", "tickets", "T-1.json");
    writeFileSync(t1, JSON.stringify({ ...JSON.parse(readFileSync(t1, "utf-8")), citesRulings: [] }, null, 2));
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [MAP.rulings.R5] }, null, 2));
    const cited = handleExport(await ctxFor(root), "phase", "p1").output;
    expect(cited.split(`### ${MAP.rulings.R5} [superseded]`).length).toBe(2);
    expect(cited.split(`### ${R1} [accepted-legacy]`).length).toBe(2);
    expect(cited.split(`### ${R1} `).length).toBe(2);
    expect(cited).toContain(`### ${R4} [proposed]`);
    expect(cited).not.toContain(q);
  });

  it("10 lifecycle isolation matrix, per operation per reader: get, incoming citation, list JSON, create-against, old reader", async () => {
    const root = withLifecycle(copy(1));
    const jsonCtx = { ...(await ctxFor(root)), format: "json" as const };
    // (a) get: an explicit proposal result, never a chain.
    const got = JSON.parse(handleRulingGet(R4, jsonCtx).output).data;
    expect(got.lifecycle).toBe("proposed");
    expect(got.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(got.chainStatus.status).toBe("nonaccepted");
    // (b) an item hand-cites R4: validate errors, the guard fails closed, the citation never converts R4.
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R4] }, null, 2));
    const out = handleValidate(await ctxFor(root)).output;
    expect(out).toContain("ruling_citation_of_nonaccepted");
    const refused = await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nPer ${R4}.`);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.instruction).toContain("proposed");
    const cited = await citationsForReviewTarget(root, "T-2");
    expect(cited.kind === "resolved" && cited.citations[0]!.status).toBe("nonaccepted");
    expect(loadRulingsSafe(root).lifecycleById.get(R4)).toBe("proposed");
    // (c) list JSON carries lifecycle on every record.
    const listed = JSON.parse(handleRulingList({}, jsonCtx).output).data as { id: string; lifecycle: string }[];
    expect(listed.find((r) => r.id === R4)!.lifecycle).toBe("proposed");
    expect(listed.find((r) => r.id === R1)!.lifecycle).toBe("accepted-legacy");
    expect(listed.every((r) => typeof r.lifecycle === "string")).toBe(true);
    // (d) a second proposal against R1 changes nothing about R1.
    const q = JSON.parse((await handleRulingPropose({ text: "Q", attribution: "owner-direct", date: "2026-09-22", scopeTags: [], proposesToSupersede: R1, clientTaskId: CALLER }, "json", root)).output).data;
    const after = loadRulingsSafe(root);
    expect(buildSuccessorIndex(after.rulings).successorsByTarget.get(R1)).toBeUndefined();
    expect(after.unavailableIds.size).toBe(0);
    expect(resolveCitation(R1, buildCitationResolutionContext(after.rulings, after.unavailableIds, "complete", false)).status).toBe("resolved");
    expect(JSON.parse(handleRulingGet(R1, { ...jsonCtx }).output).data.proposalsAgainst.sort()).toEqual([R4, q.id].sort());
    // (e) the OLD reader (1.15 code pinned at 655b03bf) over the same ledger: every record parses, R1 unsuperseded,
    // R4 shown as an ordinary current ruling. The documented boundary, not a promise.
    const oldRulings = after.rulings.map((r) => OldRulingSchema.parse(JSON.parse(JSON.stringify(r))));
    const oldIndex = oracle.buildSuccessorIndex(oldRulings);
    expect(oldIndex.successorsByTarget.get(R1)).toBeUndefined();
    const oldCtx = oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete", false);
    expect(oracle.resolveCitation(R1, oldCtx)).toMatchObject({ status: "resolved", stale: false });
    expect(oracle.resolveCitation(R4, oldCtx)).toMatchObject({ status: "resolved", stale: false, current: { id: R4 } });
  });

  it("11 revision-bound acceptance: accept refused when the proposal changed since review; accepted at the current revision; retry is a no-op", async () => {
    const root = withLifecycle(copy(1));
    const file = join(root, ".story", "rulings", `${R4}.json`);
    const reviewed = payloadDigest(RulingSchema.parse(JSON.parse(readFileSync(file, "utf-8"))));
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), text: "Background work carries the request id of the job that enqueued it, always" }, null, 2));
    const args = { revision: reviewed, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER };
    await expect(handleRulingAccept(R4, args, "json", root)).rejects.toThrow(/changed since it was reviewed/);
    expect(loadRulingsSafe(root).lifecycleById.get(R4)).toBe("proposed");
    const current = payloadDigest(RulingSchema.parse(JSON.parse(readFileSync(file, "utf-8"))));
    const accepted = JSON.parse((await handleRulingAccept(R4, { ...args, revision: current }, "json", root)).output).data;
    expect(accepted.noop).toBe(false);
    expect(accepted.supersedes).toBe(R1);
    const t2 = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-2.json"), "utf-8"));
    expect(t2.citesRulings).toContain(R4);
    const again = JSON.parse((await handleRulingAccept(R4, { ...args, revision: current }, "json", root)).output).data;
    expect(again.noop).toBe(true);
    const { rulings, unavailableIds } = loadRulingsSafe(root);
    expect(resolveCitation(R1, buildCitationResolutionContext(rulings, unavailableIds, "complete", false))).toMatchObject({ status: "resolved", stale: true, current: { id: R4 } });
  });

  it("12 interrupted-accept recovery: covered where the commit-phase failure can be injected, test/core/ruling-transaction-recovery.test.ts (T-522 case 12)", () => {
    const src = readFileSync(resolve(__dirname, "../core/ruling-transaction-recovery.test.ts"), "utf-8");
    expect(src).toContain("continuity case 12");
  });

  it("13 merge integrity: acceptance does not survive onto an edited revision; the merged record binds nothing until resolved", async () => {
    const root = withLifecycle(copy(1));
    const base = JSON.parse(readFileSync(join(root, ".story", "rulings", `${R4}.json`), "utf-8")) as Record<string, unknown>;
    const reviewed = payloadDigest(RulingSchema.parse(base));
    await handleRulingAccept(R4, { revision: reviewed, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    const sideA = JSON.parse(readFileSync(join(root, ".story", "rulings", `${R4}.json`), "utf-8")) as Record<string, unknown>;
    const sideB = { ...base, text: "Background work carries the request id of the job that enqueued it, always" };
    for (const [ours, theirs] of [[sideA, sideB], [sideB, sideA]] as const) {
      const merged = threeWayMerge(base, ours, theirs, "ruling").merged;
      const parsed = RulingSchema.parse(merged);
      expect(classifyLifecycle(parsed).lifecycle).toBe("conflicted");
      const editedWithAcceptance = parsed.text === sideB.text && parsed.acceptance !== undefined;
      expect(editedWithAcceptance).toBe(false);
      if (parsed.acceptance) expect(parsed.acceptance.payloadDigest).toBe(payloadDigest(parsed));
      // Written back, the merged record binds nothing: R1's chain is indeterminate and a citation of R4 is refused.
      writeFileSync(join(root, ".story", "rulings", `${R4}.json`), JSON.stringify(merged, null, 2));
      const { rulings, unavailableIds } = loadRulingsSafe(root);
      const ctx = buildCitationResolutionContext(rulings, unavailableIds, "complete", false);
      expect(resolveCitation(R1, ctx).status).toBe("indeterminate");
      expect(resolveCitation(R4, ctx).status).toBe("nonaccepted");
      const verdict = await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nPer ${R4}.`);
      expect(verdict.ok).toBe(false);
      expect(handleValidate(await ctxFor(root)).output).toContain("unresolved_conflicts");
    }
  });
});
