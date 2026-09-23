import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2ECliFixture, runE2ECli, CLI_PATH } from "../helpers/e2e-cli.js";
import { git as fixtureGit, gitAllowFailure } from "../helpers/git-fixture.js";

/**
 * T-529: the two catalogs merged by real `git merge` through the installed
 * driver. Standalone temp repositories only (ISS-1220).
 */

const driverCmd = `node ${CLI_PATH} merge-driver %O %A %B %P`;

let fixture: E2ECliFixture;
const dirs: string[] = [];
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Rec = Record<string, unknown>;

function git(dir: string, ...args: string[]): string {
  return fixtureGit(dir, args, { env: { GIT_MERGE_AUTOEDIT: "no" } });
}

function gitMerge(dir: string, branch: string): number {
  return gitAllowFailure(dir, ["merge", "--no-edit", branch], { env: { GIT_MERGE_AUTOEDIT: "no" } }).status;
}

function cli(dir: string, ...args: string[]): { exitCode: number; stdout: string } {
  const r = runE2ECli(fixture, args, { cwd: dir });
  return { exitCode: r.status ?? 1, stdout: r.stdout };
}

function createTeamRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-merge-e2e-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "merge.storybloq-json.driver", driverCmd);
  git(dir, "config", "merge.storybloq-json.name", "Storybloq JSON three-way merge");
  const storyDir = join(dir, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  writeFileSync(join(storyDir, ".gitattributes"), "capabilities.json merge=storybloq-json\nglossary.json merge=storybloq-json\n");
  writeFileSync(
    join(storyDir, "config.json"),
    JSON.stringify(
      {
        version: 2,
        project: "test",
        type: "npm",
        language: "ts",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
        team: { enabled: true },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({ title: "test", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "First." }], blockers: [] }, null, 2) + "\n",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const id of ["cap-a", "cap-b", "cap-c"]) writeFileSync(join(dir, "src", `${id}.ts`), `export const id = "${id}";\n`);
  return dir;
}

function cap(id: string, over: Rec = {}): Rec {
  return {
    id,
    name: `Name ${id}`,
    summary: `Summary of ${id}.`,
    surfaces: {},
    entryPoints: [`src/${id}.ts`],
    contract: `Contract of ${id}.`,
    checkedAt: { sha: "a".repeat(12), date: "2026-09-20" },
    status: "current",
    ...over,
  };
}

function writeCaps(dir: string, entries: Rec[]): void {
  writeFileSync(join(dir, ".story", "capabilities.json"), JSON.stringify({ version: 1, capabilities: entries }, null, 2) + "\n");
}

function writeTerms(dir: string, entries: Rec[]): void {
  writeFileSync(join(dir, ".story", "glossary.json"), JSON.stringify({ version: 1, terms: entries }, null, 2) + "\n");
}

function readJson(dir: string, name: string): Rec {
  const text = readFileSync(join(dir, ".story", name), "utf-8");
  expect(text).not.toContain("<<<<<<<");
  return JSON.parse(text) as Rec;
}

/** base on main, `ours` on branch-b, `theirs` on branch-a; branch-b merges branch-a. */
function divergeAndMerge(dir: string, write: (side: "base" | "ours" | "theirs") => void): number {
  write("base");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "branch-a");
  write("theirs");
  git(dir, "commit", "-q", "-am", "theirs");
  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "branch-b");
  write("ours");
  git(dir, "commit", "-q", "-am", "ours");
  return gitMerge(dir, "branch-a");
}

describe("T-529: real git merges of the catalogs through the installed driver", () => {
  it("add/add of different capabilities merges clean, and the merged file loads", () => {
    const dir = createTeamRepo();
    const exit = divergeAndMerge(dir, (side) => {
      if (side === "base") writeCaps(dir, [cap("cap-a")]);
      if (side === "ours") writeCaps(dir, [cap("cap-a"), cap("cap-b")]);
      if (side === "theirs") writeCaps(dir, [cap("cap-a"), cap("cap-c")]);
    });
    expect(exit).toBe(0);
    const merged = readJson(dir, "capabilities.json");
    expect((merged.capabilities as Rec[]).map((c) => c.id)).toEqual(["cap-a", "cap-b", "cap-c"]);
    expect(merged._conflicts).toBeUndefined();
    const list = cli(dir, "capability", "list", "--format", "json");
    expect(list.exitCode).toBe(0);
    expect(((JSON.parse(list.stdout) as { data: { capabilities: Rec[] } }).data.capabilities).map((c) => c.id)).toEqual(["cap-a", "cap-b", "cap-c"]);
  });

  it("a payload edit against a stamp of the same capability: one coupled record by entry id, and the file still loads", () => {
    const dir = createTeamRepo();
    const exit = divergeAndMerge(dir, (side) => {
      if (side === "base") writeCaps(dir, [cap("cap-b"), cap("cap-a")]);
      if (side === "ours") writeCaps(dir, [cap("cap-b"), cap("cap-a", { contract: "Ours: a changed contract." })]);
      if (side === "theirs") writeCaps(dir, [cap("cap-b"), cap("cap-a", { checkedAt: { sha: "b".repeat(12), date: "2026-09-22" } })]);
    });
    expect(exit).not.toBe(0);
    const merged = readJson(dir, "capabilities.json");
    const records = merged._conflicts as Rec[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fieldPath: "/capabilities/1", kind: "coupled", group: "verification", entityId: "cap-a" });
    // The entry holds ours' verification group whole: the edit, with ours' (old) stamp.
    const entry = (merged.capabilities as Rec[])[1]!;
    expect(entry.contract).toBe("Ours: a changed contract.");
    expect(entry.checkedAt).toEqual({ sha: "a".repeat(12), date: "2026-09-20" });
    const show = cli(dir, "conflicts", "show", "capabilities.json");
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('"cap-a" [coupled] (group: verification)');
    const get = cli(dir, "capability", "get", "cap-a", "--format", "json");
    expect(get.exitCode).toBe(0);
    expect((JSON.parse(get.stdout) as { data: Rec }).data.effectiveStatus).toBe("review");
  });

  it("a word claimed on two branches: one invariant record, the glossary loads, conflicts list names it", () => {
    const dir = createTeamRepo();
    const term = (id: string, word: string, over: Rec = {}): Rec => ({ id, term: word, definition: `What ${word} means.`, updatedAt: "2026-09-20T10:00:00.000Z", ...over });
    const exit = divergeAndMerge(dir, (side) => {
      if (side === "base") writeTerms(dir, [term("term-z", "floor")]);
      if (side === "ours") writeTerms(dir, [term("term-z", "floor"), term("term-b", "pen")]);
      if (side === "theirs") writeTerms(dir, [term("term-z", "floor"), term("term-a", "manager", { aliases: ["Pen"] })]);
    });
    expect(exit).not.toBe(0);
    const merged = readJson(dir, "glossary.json");
    expect(merged._conflicts).toEqual([{ fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen", entityIds: ["term-a", "term-b"] }]);
    const list = cli(dir, "conflicts", "list", "--format", "json");
    expect(list.exitCode).toBe(0);
    expect((JSON.parse(list.stdout) as { data: { items: Rec[] } }).data.items).toContainEqual({ type: "glossary", id: "glossary.json", conflictCount: 1 });
    const terms = cli(dir, "term", "list", "--format", "json");
    expect(terms.exitCode).toBe(0);
  });
});
