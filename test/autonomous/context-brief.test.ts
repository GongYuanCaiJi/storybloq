/**
 * T-526 section 4: the context brief. Discovery reads the ledger, the catalogs
 * and git; these tests pin what it suggests, why, what it refuses to suggest,
 * what it discloses, and that fitting never lets the record disagree with the
 * text that shipped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  BriefItemNotFoundError,
  buildContextBrief,
  extractPathKeys,
  NO_CONFIDENT_MATCH,
  NO_PATHS_NAMED,
  pathKeySegments,
  SUGGESTED_CAP,
  TIER_RULE,
} from "../../src/autonomous/context-brief.js";
import { hashTree, materialize, TASKS } from "../../scripts/continuity-lib.js";

const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const MAP = JSON.parse(readFileSync(join(FIXTURE, "fixture-map.json"), "utf-8")) as { rulings: Record<string, string> };
const R = MAP.rulings as { R1: string; R2: string; R3: string; R4: string; R5: string };

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function copy(arm: 1 | 2 | 3, task: (typeof TASKS)[number] = "T-2.a"): string {
  const dest = mkdtempSync(join(tmpdir(), "context-brief-"));
  materialize(FIXTURE, arm, task, dest);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (args: string[]): void => { execFileSync("git", args, { cwd: dest, env, stdio: "ignore" }); };
  g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  roots.push(dest);
  return dest;
}

function editJson(root: string, rel: string, edit: (v: Record<string, unknown>) => Record<string, unknown>): void {
  const p = join(root, rel);
  writeFileSync(p, JSON.stringify(edit(JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>), null, 2));
}

/** The body of one `## ` section of the rendered brief, or "" when the section was not rendered. */
function section(rendered: string, heading: string): string {
  const start = rendered.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const next = rendered.indexOf("\n## ", start + 4);
  return rendered.slice(start, next < 0 ? undefined : next);
}

/** A ruling file shaped like the fixture's, with the fields a test varies. */
function addRuling(root: string, id: string, scopeTags: string[], date: string, text: string): void {
  const base = JSON.parse(readFileSync(join(root, ".story", "rulings", `${R.R3}.json`), "utf-8")) as Record<string, unknown>;
  writeFileSync(
    join(root, ".story", "rulings", `${id}.json`),
    JSON.stringify({ ...base, id, scopeTags, date, text, supersedes: null, createdAt: `${date}T12:00:00.000Z` }, null, 2),
  );
}

describe("path keys (B-B)", () => {
  it("extracts slash paths and known-extension files, never versions or URLs", () => {
    expect(extractPathKeys("in src/jobs/ and AppLogger.ts")).toEqual(["src/jobs/", "AppLogger.ts"]);
    expect(extractPathKeys("ships in 1.15.9 per https://x/y.ts")).toEqual([]);
  });

  it("a segment may carry one leading dot; traversal is never a key", () => {
    expect(extractPathKeys("edit .github/workflows/ci.yml")).toEqual([".github/workflows/ci.yml"]);
    expect(extractPathKeys("see .story/tickets/T-001.json now")).toEqual([".story/tickets/T-001.json"]);
    expect(extractPathKeys("under src/.config/app.ts")).toEqual(["src/.config/app.ts"]);
    expect(extractPathKeys("not ../etc/passwd or ../x/y.ts")).toEqual([]);
    expect(pathKeySegments(".github/workflows/")).toEqual(["github", "workflows"]);
  });

  it("segments drop the generic literals and anything under three characters", () => {
    expect(pathKeySegments("src/jobs/")).toEqual(["jobs"]);
    expect(pathKeySegments("lib/ab/tests/queue.ts")).toEqual(["queue.ts"]);
  });
});

describe("case 1: delivery tiers", () => {
  it("arm 1 (a): no binding, R2 then R1 suggested newest-first with their keys, R3 and the superseded R5 absent", async () => {
    const brief = await buildContextBrief(copy(1), "T-2");
    expect(brief.binding).toEqual([]);
    expect(brief.suggested.map((s) => s.id)).toEqual([R.R2, R.R1]);
    const r2 = brief.suggested[0]!;
    expect(r2.reasons).toContain("tag:jobs (path src/jobs/)");
    expect(r2.reasons).toContain("tag:logging (title word)");
    expect(brief.suggested[1]!.reasons).toContain("tag:logging (title word)");
    expect(brief.rendered).not.toContain(R.R3);
    expect(brief.suggested.map((s) => s.id)).not.toContain(R.R5);
    expect(brief.rendered).toContain("none: this item cites no rulings");
    expect(brief.rendered).toContain(TIER_RULE);
    expect(brief.disclosure).toContain("no capability inventory");
    expect(brief.disclosure).toContain("no glossary");
  });

  it("arm 3 (a): cap-logging is delivered by its title word, and R1 is also reached through it", async () => {
    const brief = await buildContextBrief(copy(3), "T-2");
    const cap = brief.capabilities.find((c) => c.id === "cap-logging");
    expect(cap).toBeDefined();
    expect(cap!.reasons).toContain("title:logging");
    expect(brief.rendered).toContain("Where inspection starts, not a substitute for reading the implementation.");
    expect(brief.suggested.find((s) => s.id === R.R1)!.reasons).toContain("capability:cap-logging");
    expect(brief.terms.map((t) => t.id).sort()).toEqual(["term-redaction", "term-request-id"]);
    expect(brief.disclosure).not.toContain("no capability inventory");
  });

  it("a cited ruling binds and is never also suggested", async () => {
    const root = copy(1);
    editJson(root, ".story/tickets/T-2.json", (t) => ({ ...t, citesRulings: [R.R2] }));
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.binding.map((b) => (b.status === "resolved" ? b.current.id : b.citedId))).toEqual([R.R2]);
    expect(brief.suggested.map((s) => s.id)).toEqual([R.R1]);
  });

  it("an unknown item is refused by name, not rendered empty", async () => {
    await expect(buildContextBrief(copy(1), "T-99")).rejects.toBeInstanceOf(BriefItemNotFoundError);
  });
});

describe("scope-tag matching (ruling (a), 2026-09-22)", () => {
  it("a stop word and a sub-3-character segment never suggest", async () => {
    const root = copy(1);
    addRuling(root, "r-aaaaaaaaaaaaaaaa", ["for"], "2026-09-16", "Owner: a ruling tagged with a stop word.");
    addRuling(root, "r-bbbbbbbbbbbbbbbb", ["ab"], "2026-09-16", "Owner: a ruling tagged with a short segment.");
    addRuling(root, "r-cccccccccccccccc", ["src"], "2026-09-16", "Owner: a ruling tagged with a generic literal.");
    editJson(root, ".story/tickets/T-2.json", (t) => ({ ...t, title: "Add logging for jobs", description: "Work in src/ab/jobs/ for the queue." }));
    const ids = (await buildContextBrief(root, "T-2")).suggested.map((s) => s.id);
    expect(ids).not.toContain("r-aaaaaaaaaaaaaaaa");
    expect(ids).not.toContain("r-bbbbbbbbbbbbbbbb");
    expect(ids).not.toContain("r-cccccccccccccccc");
  });

  it("a phase id tag and a matched capability id tag each suggest, with the key named", async () => {
    const root = copy(3);
    addRuling(root, "r-dddddddddddddddd", ["p1"], "2026-09-16", "Owner: a phase-wide ruling.");
    addRuling(root, "r-eeeeeeeeeeeeeeee", ["cap-logging"], "2026-09-16", "Owner: a ruling on the logging capability.");
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.suggested.find((s) => s.id === "r-dddddddddddddddd")!.reasons).toContain("tag:p1 (phase)");
    expect(brief.suggested.find((s) => s.id === "r-eeeeeeeeeeeeeeee")!.reasons).toContain("tag:cap-logging (capability id)");
  });

  it("suggestions are capped, and the overflow is disclosed with the command that lists the rest", async () => {
    const root = copy(1);
    for (let i = 0; i < SUGGESTED_CAP + 2; i++) {
      addRuling(root, `r-${String(i).padStart(2, "0")}zzzzzzzzzzzzzz`, ["jobs"], "2026-09-17", `Owner: jobs ruling ${i}.`);
    }
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.suggested).toHaveLength(SUGGESTED_CAP + 4);
    expect(brief.delivered.suggested).toHaveLength(SUGGESTED_CAP);
    expect(brief.delivered.suggested).toEqual(brief.suggested.slice(0, SUGGESTED_CAP).map((x) => x.id));
    expect(brief.disclosure).toContain(`4 suggested ruling(s) not shown (cap ${SUGGESTED_CAP}, newest first); list them with \`storybloq ruling list --scope-tag <tag>\``);
  });
});

describe("case 6: no-path variant (b)", () => {
  it("delivers cap-logging by title word and says no paths were named", async () => {
    const brief = await buildContextBrief(copy(3, "T-2.b"), "T-2");
    expect(brief.keys.paths).toEqual([]);
    expect(brief.disclosure).toContain(NO_PATHS_NAMED);
    expect(brief.capabilities.find((c) => c.id === "cap-logging")!.reasons).toContain("title:logging");
  });
});

describe("P-4: short title words are not a confident match", () => {
  it("variant (c): R2 reached only by `jobs` is marked, and R1 is not suggested", async () => {
    const brief = await buildContextBrief(copy(1, "T-2.c"), "T-2");
    const r2 = brief.suggested.find((s) => s.id === R.R2)!;
    expect(r2.confidence).toBe(NO_CONFIDENT_MATCH);
    expect(brief.rendered).toContain(NO_CONFIDENT_MATCH);
    expect(brief.suggested.map((s) => s.id)).not.toContain(R.R1);
  });
});

describe("catalog families", () => {
  it("a renamed entry point moves the capability to STALE and out of the candidates", async () => {
    const root = copy(3);
    execFileSync("git", ["mv", "src/platform/logging", "src/platform/log"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", "mv"], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.capabilities.map((c) => c.id)).not.toContain("cap-logging");
    expect(brief.stale.map((s) => s.id)).toContain("cap-logging");
    expect(brief.rendered).toContain("not usable as an implementation candidate");
  });

  it("an unreadable capability file is disclosed by class, never read as no inventory", async () => {
    const root = copy(3);
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.families.capabilities.state).toBe("unreadable");
    expect(brief.disclosure.some((d) => d.startsWith("capabilities unavailable:"))).toBe(true);
    expect(brief.disclosure).not.toContain("no capability inventory");
  });

  it("a check that hits its deadline renders check-incomplete with a count", async () => {
    let calls = 0;
    const brief = await buildContextBrief(copy(3), "T-2", { checkOptions: { now: () => (calls++ === 0 ? 0 : 1e12) } });
    expect(brief.families.capabilities.state).toBe("check-incomplete");
    expect(brief.disclosure.some((d) => /check-incomplete: \d+ entry\(ies\) not checked/.test(d))).toBe(true);
  });

  it("a pending note renders on the entry and is recorded in the manifest", async () => {
    const root = copy(3);
    editJson(root, ".story/capabilities.json", (doc) => ({
      ...doc,
      capabilities: (doc.capabilities as Record<string, unknown>[]).map((c) => (c.id === "cap-logging" ? { ...c, pendingNote: "redaction for job payloads is owed" } : c)),
    }));
    const brief = await buildContextBrief(root, "T-2");
    expect(brief.rendered).toContain("redaction for job payloads is owed");
    expect(brief.manifest.capabilities.find((c) => c.id === "cap-logging")!.pendingNote).toBe("redaction for job payloads is owed");
  });
});

describe("fitting and the record", () => {
  it("delivered ids are exactly the ids in the rendered text, at every budget", async () => {
    const root = copy(3);
    // Multibyte text, so a character count and a byte count disagree.
    editJson(root, ".story/capabilities.json", (doc) => ({
      ...doc,
      capabilities: (doc.capabilities as Record<string, unknown>[]).map((c) => (c.id === "cap-logging" ? { ...c, pendingNote: "éèê—漢字".repeat(20) } : c)),
    }));
    for (const budget of [16_000, 2_500, 1_600, 400]) {
      const brief = await buildContextBrief(root, "T-2", { budgetBytes: budget });
      const sug = section(brief.rendered, "Suggested accepted rulings");
      const caps = section(brief.rendered, "Capabilities");
      const terms = section(brief.rendered, "Terms");
      for (const s of brief.suggested) expect(sug.includes(`**${s.id}**`), `${s.id} at ${budget}`).toBe(brief.delivered.suggested.includes(s.id));
      for (const c of brief.capabilities) expect(caps.includes(`(${c.id})`), `${c.id} at ${budget}`).toBe(brief.delivered.capabilities.includes(c.id));
      for (const t of brief.terms) expect(terms.includes(`(${t.id})`), `${t.id} at ${budget}`).toBe(brief.delivered.terms.includes(t.id));
      for (const r of brief.manifest.rulings.filter((x) => x.tier === "suggested")) expect(r.delivered).toBe(brief.delivered.suggested.includes(r.id));
      expect(brief.rendered).toContain("## Disclosure");
      if (/brief over budget by \d+ bytes/.test(brief.rendered)) {
        for (const h of ["Suggested accepted rulings", "Capabilities", "Stale or unavailable", "Terms", "Lessons"]) expect(section(brief.rendered, h), `${h} at ${budget}`).toBe("");
      } else {
        expect(Buffer.byteLength(brief.rendered, "utf8"), `bytes at ${budget}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("a budget too small for the optional sections keeps the mandatory ones and says what was omitted", async () => {
    const root = copy(3);
    editJson(root, ".story/tickets/T-2.json", (t) => ({ ...t, citesRulings: [R.R2] }));
    const brief = await buildContextBrief(root, "T-2", { budgetBytes: 400 });
    expect(brief.rendered).toContain("# Context brief: T-2");
    expect(section(brief.rendered, "Item")).not.toBe("");
    expect(section(brief.rendered, "Cited Rulings")).toContain(R.R2);
    expect(section(brief.rendered, "Disclosure")).not.toBe("");
    expect(brief.rendered).toMatch(/brief over budget by \d+ bytes: mandatory sections only/);
    expect(brief.delivered.suggested).toEqual([]);
  });

  it("the stated overshoot is exact, including where stating it widens the number", async () => {
    const root = copy(3);
    const overshoot = (rendered: string, budget: number): { claimed: number; actual: number } => ({
      claimed: Number(/brief over budget by (\d+) bytes/.exec(rendered)![1]),
      actual: Buffer.byteLength(rendered, "utf8") - budget,
    });
    // Mandatory text without the number: whatever budget 1 renders, less the digits it states.
    const at1 = (await buildContextBrief(root, "T-2", { budgetBytes: 1 })).rendered;
    const base = Buffer.byteLength(at1, "utf8") - String(overshoot(at1, 1).claimed).length;
    // Budgets where a two-digit first estimate becomes a three-digit overshoot.
    for (const budget of [base - 97, base - 98, base - 99, base - 100]) {
      const { claimed, actual } = overshoot((await buildContextBrief(root, "T-2", { budgetBytes: budget })).rendered, budget);
      expect(claimed, `budget ${budget}`).toBe(actual);
    }
  });

  it("is write-free: the working tree is byte-identical after a build", async () => {
    const root = copy(3);
    const before = hashTree(root);
    await buildContextBrief(root, "T-2");
    expect(hashTree(root)).toEqual(before);
  });
});
