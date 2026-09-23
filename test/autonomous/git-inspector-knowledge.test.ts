/**
 * T-527: the path-only git reads behind the knowledge review. Real git in
 * standalone temp repositories (ISS-1220).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  gitChangedPaths,
  gitCommitPaths,
  gitFirstParent,
  gitRevList,
  gitStoryDirty,
  gitStoryTree,
} from "../../src/autonomous/git-inspector.js";

const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" });
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "git-knowledge-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  return root;
}
function data<T>(r: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

describe("gitChangedPaths", () => {
  it("reports both endpoints of a rename, deletions, and unusual paths byte-exact", async () => {
    const root = repo();
    const body = "line one\nline two\nline three\nline four\n";
    write(root, "src/old-name.ts", body);
    write(root, "src/gone.ts", "bye\n");
    const from = commit(root, "base");
    git(root, ["mv", "src/old-name.ts", "src/new-name.ts"]);
    git(root, ["rm", "-q", "src/gone.ts"]);
    write(root, "src/with space\nand newline.ts", "odd\n");
    const to = commit(root, "change");
    const changed = data(await gitChangedPaths(root, from, to));
    expect(changed).toContainEqual({ status: "R", path: "src/new-name.ts", oldPath: "src/old-name.ts" });
    expect(changed).toContainEqual({ status: "D", path: "src/gone.ts" });
    expect(changed).toContainEqual({ status: "A", path: "src/with space\nand newline.ts" });
    expect(changed).toHaveLength(3);
  });

  it("refuses an option-shaped ref by validation, before git runs", async () => {
    const root = repo();
    write(root, "a.txt", "a\n");
    const oid = commit(root, "base");
    const refusedRef = { ok: false, reason: "git_error", message: "invalid ref format" };
    expect(await gitChangedPaths(root, "--output=x", oid)).toEqual(refusedRef);
    expect(await gitChangedPaths(root, oid, "--output=x")).toEqual(refusedRef);
  });
});

describe("gitStoryDirty", () => {
  it("ignores ignored session state and sees modified, staged and untracked ledger files", async () => {
    const root = repo();
    write(root, ".gitignore", ".story/sessions/\n");
    write(root, ".story/capabilities.json", "{}\n");
    commit(root, "base");
    write(root, ".story/sessions/abc/state.json", "{}\n");
    expect(data(await gitStoryDirty(root))).toBe(false);
    write(root, ".story/notes/n-new.json", "{}\n");
    expect(data(await gitStoryDirty(root))).toBe(true);
    rmSync(join(root, ".story/notes"), { recursive: true });
    write(root, ".story/capabilities.json", "{ }\n");
    expect(data(await gitStoryDirty(root))).toBe(true);
    git(root, ["add", ".story/capabilities.json"]);
    expect(data(await gitStoryDirty(root))).toBe(true);
  });

  it("does not see changes outside .story/", async () => {
    const root = repo();
    write(root, ".story/capabilities.json", "{}\n");
    write(root, "src/a.ts", "1\n");
    commit(root, "base");
    write(root, "src/a.ts", "2\n");
    expect(data(await gitStoryDirty(root))).toBe(false);
  });
});

describe("gitRevList and gitCommitPaths", () => {
  it("lists side-branch commits unless first-parent, and a merge's paths are its first-parent diff", async () => {
    const root = repo();
    write(root, "a.txt", "a\n");
    const base = commit(root, "base");
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, "side.ts", "s\n");
    const side = commit(root, "side");
    git(root, ["checkout", "-q", "main"]);
    write(root, ".story/n.json", "{}\n");
    const main = commit(root, "main");
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge", "side"]);
    const merge = git(root, ["rev-parse", "HEAD"]).trim();

    expect(data(await gitRevList(root, base, merge, { firstParent: true }))).toEqual([main, merge]);
    const all = data(await gitRevList(root, base, merge, { firstParent: false }));
    expect(new Set(all)).toEqual(new Set([side, main, merge]));
    expect(all[all.length - 1]).toBe(merge);

    expect(data(await gitCommitPaths(root, merge))).toEqual(["side.ts"]);
    expect(data(await gitCommitPaths(root, main))).toEqual([".story/n.json"]);

    expect(data(await gitRevList(root, base, merge, { firstParent: true, mergesOnly: true }))).toEqual([merge]);
    expect(data(await gitFirstParent(root, merge))).toBe(main);
    expect(data(await gitFirstParent(root, side))).toBe(base);
    expect(data(await gitFirstParent(root, base))).toBeNull();
  });
});

describe("gitStoryTree", () => {
  it("returns the .story tree id, the same id for an identical tree, and null without .story", async () => {
    const root = repo();
    write(root, "a.txt", "a\n");
    const bare = commit(root, "no ledger");
    write(root, ".story/n.json", "{}\n");
    const one = commit(root, "ledger");
    write(root, "a.txt", "b\n");
    const two = commit(root, "code only");
    expect(data(await gitStoryTree(root, bare))).toBeNull();
    const t1 = data(await gitStoryTree(root, one));
    expect(t1).toMatch(/^[0-9a-f]{40}$/);
    expect(data(await gitStoryTree(root, two))).toBe(t1);
  });
});
