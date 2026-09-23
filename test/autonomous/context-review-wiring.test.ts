/**
 * T-526 section 2: what the plan gate and the review packet do with the
 * context manifest. The guard refuses a plan that does not name an outstanding
 * obligation even when the item cites nothing; the packet carries suggestions
 * as evidence, never as citations; the skill text tells the pen and the agent
 * the same rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guardPlanNamesCitedRulings } from "../../src/autonomous/plan-pin-guard.js";
import { buildReviewContextPacket, formatSuggestedSection } from "../../src/autonomous/review-context-packet.js";
import { existingLineProblem, PLAN_REVIEWER_CHECKS } from "../../src/autonomous/plan-context.js";
import { materialize } from "../../scripts/continuity-lib.js";

const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const SKILL = resolve(__dirname, "../../src/skill");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "context-wiring-"));
  materialize(FIXTURE, 1, "T-2.a", root);
  roots.push(root);
  return root;
}

describe("plan-pin guard: governing obligations", () => {
  it("refuses a plan that does not name an outstanding id, even for an item that cites nothing", async () => {
    const root = fixture();
    const verdict = await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNothing named.", ["r-p19bbvh0jhj8xgma"]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.instruction).toContain("governing context changed: r-p19bbvh0jhj8xgma is not named in the plan");
  });

  it("passes once the id is named, and with no obligations behaves exactly as before", async () => {
    const root = fixture();
    expect((await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nPer r-p19bbvh0jhj8xgma.", ["r-p19bbvh0jhj8xgma"])).ok).toBe(true);
    expect((await guardPlanNamesCitedRulings(root, "T-2", "# Plan"))).toEqual({ ok: true });
  });
});

describe("EXISTING line", () => {
  it("accepts both shapes and refuses absence, emptiness and a bare none", () => {
    expect(existingLineProblem("EXISTING: src/a.ts ; reuse ; covers it")).toBeNull();
    expect(existingLineProblem("EXISTING: none found within src/jobs/; closest JobQueue lacks logging; new implementation limited to src/jobs/")).toBeNull();
    expect(existingLineProblem("# Plan\n\n1. step")).toBe("the plan has no EXISTING line");
    expect(existingLineProblem("EXISTING:   ")).toBe("the plan has no EXISTING line");
    expect(existingLineProblem("EXISTING: none")).toMatch(/says none without naming what was inspected/);
    expect(existingLineProblem("  EXISTING: indented")).toBe("the plan has no EXISTING line");
  });
});

describe("review packet: suggested (not binding)", () => {
  it("lists ids with bounded reasons, names the manifest, and never calls a suggestion cited", () => {
    const long = "k".repeat(400);
    const text = formatSuggestedSection(
      [{ id: "r-aaaaaaaaaaaaaaaa", reasons: ["tag:jobs (path src/jobs/)"] }, { id: "r-bbbbbbbbbbbbbbbb", reasons: [long] }],
      { ref: "context-manifests/T-2-3", provisional: false },
    );
    expect(text).toContain("contextManifest: context-manifests/T-2-3");
    expect(text).toContain("# Suggested (not binding)");
    expect(text).toContain("- r-aaaaaaaaaaaaaaaa (suggested by tag:jobs (path src/jobs/))");
    expect(text).toContain(`${"k".repeat(200)}...`);
    expect(text).not.toContain("k".repeat(201));
    expect(text).not.toMatch(/\bcited\b/i);
  });

  it("marks a provisional manifest, and renders nothing when there is nothing to say", () => {
    expect(formatSuggestedSection([], { ref: "context-manifests/T-2-2", provisional: true })).toMatch(/^contextManifest: context-manifests\/T-2-2 \(provisional: /);
    expect(formatSuggestedSection([], undefined)).toBe("");
  });

  it("the section and the plan checks are mandatory: they survive a budget that sheds everything optional", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-packet-"));
    roots.push(dir);
    const packet = buildReviewContextPacket({
      sessionDir: dir, projectRoot: dir, target: "T-2", stage: "plan", generation: 0, roundNum: 1, budget: 10,
      captureDirective: "capture", suggestedRulings: [{ id: "r-aaaaaaaaaaaaaaaa", reasons: ["tag:jobs (title word)"] }],
      contextManifest: { ref: "context-manifests/T-2-1", provisional: false }, reviewerChecks: PLAN_REVIEWER_CHECKS,
    });
    expect(packet.text).toContain("- r-aaaaaaaaaaaaaaaa (suggested by tag:jobs (title word))");
    expect(packet.text).toContain(`- ${PLAN_REVIEWER_CHECKS[0]}`);
    expect(packet.text.indexOf("# Suggested (not binding)")).toBeLessThan(packet.text.indexOf("CONTEXT COMPLETENESS"));
  });
});

describe("the contract and the skill say the same thing", () => {
  it("review-contract-template.md names both findings inside the lens head", () => {
    const t = readFileSync(join(SKILL, "review-contract-template.md"), "utf-8");
    const head = t.slice(0, 3000);
    expect(head).toContain("a suggested ruling that applies and is not cited");
    expect(head).toContain("a grep transcript in EXISTING");
  });

  it("orchestrator-mode.md carries the EXISTING template line after VERIFIED STATE and the three lookups", () => {
    const t = readFileSync(join(SKILL, "orchestrator-mode.md"), "utf-8");
    const verified = t.indexOf("VERIFIED STATE @ <sha> (<date>):");
    const existing = t.indexOf("EXISTING: <reference> ; reuse | extend | replace ; <one-line reason>");
    expect(existing).toBeGreaterThan(verified);
    expect(t.indexOf("SCOPE: <numbered", existing)).toBeGreaterThan(existing);
    for (const lookup of ["storybloq_ruling_list {scopeTag}", "storybloq_capability_match", "storybloq_term_match"]) expect(t).toContain(lookup);
    expect(t).toContain("is cited on the item now (`ticket update --cites-ruling`), never pasted");
  });

  it("autonomous-mode.md has the Context brief section with the tiers and the rebase command", () => {
    const t = readFileSync(join(SKILL, "autonomous-mode.md"), "utf-8");
    const section = t.slice(t.indexOf("## Context brief"), t.indexOf("\n## ", t.indexOf("## Context brief") + 3));
    expect(section).toContain("**Suggested rulings** bind nothing");
    expect(section).toContain("EXISTING");
    expect(section).toContain('storybloq brief --rebase <sessionId> <item> --reason "<why>"');
  });
});
