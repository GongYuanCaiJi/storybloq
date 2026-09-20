/**
 * T-525: the continuity deterministic suite. Cases assert structure through
 * the REAL path (F-B): the validate handler, the citation packet, the guide's
 * own PLAN instruction. Cases whose feature has not landed are named here as
 * todo with the owning ticket; that ticket records the RED evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProject } from "../../src/core/project-loader.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { citationsForReviewTarget } from "../../src/autonomous/cited-rulings.js";
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
  it.todo("3 proposed not binding: R4 renders under Proposed, the guard ignores it, R1 stays current, no successor index entry for R1 (T-522; entry: resolveCitation, buildSuccessorIndex, packet; uses overlays/lifecycle)");
  it.todo("6 no-path variant (b) delivers cap-logging by title-word match with the no-paths-named disclosure (T-523 + T-526)");
  it.todo("7 EXISTING gate: a plan without the EXISTING line is retried (T-526; entry: PLAN report)");
  it.todo("7n EXISTING negative: a grep transcript in the EXISTING line is a plan-review finding; asserts the reviewer prompt line (T-526; entry: PLAN_REVIEW instruction text)");
  it.todo("8 completion: T-3 move marks cap-logging review at FINALIZE; a report without knowledgeImpact is retried; stale-reference advances and lands in the handover (T-527)");
  it.todo("9 arm 2 subset: with the capability file removed, cases 1 to 5 and 7 pass and the disclosure says no capability inventory (T-526)");
  it.todo("10 lifecycle isolation matrix, per operation per reader: ruling get, incoming citation, list/export/JSON, create-against, old-reader fixture (T-522 P-1)");
  it.todo("11 revision-bound acceptance: accept refused when the proposal changed since review; idempotent retry (T-522 P-2)");
  it.todo("12 interrupted-accept recovery via the ruling-create transaction pattern (T-522 P-2)");
  it.todo("13 merge integrity: acceptance does not survive onto an edited revision (T-522 P-3)");
  it.todo("14 context manifest change detection on resume, replan and CODE_REVIEW entry (T-526 P-3)");
  it.todo("15 second-handoff maintenance: a disposition per impact, follow-up durable across a second session (T-527 P-1/P-2)");
});
