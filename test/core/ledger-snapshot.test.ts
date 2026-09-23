/**
 * T-526 (plan 3.2): ledger snapshots and the snapshot-aware checkers.
 *
 * Standalone temp repositories only (ISS-1220): fixture git config writes in a
 * linked worktree reach the shared `.git/config`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLedgerSnapshot, SNAPSHOT_RECORD_MAX_BYTES, type SnapshotGitRunner } from "../../src/core/ledger-snapshot.js";
import { checkCapabilities } from "../../src/core/capability.js";
import { buildTermReferenceIndexFromSnapshot, buildTermReferenceIndex, checkTerms } from "../../src/core/glossary.js";
import { CapabilitySchema, type Capability } from "../../src/models/capability.js";
import { TermSchema } from "../../src/models/glossary.js";

const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" });
}
function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-snapshot-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  return root;
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

const R1 = "r-0000000000000001";
function ruling(id: string, text = "Some ruling"): string {
  return JSON.stringify({
    id,
    text,
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "fixture" },
    date: "2026-09-20",
    scopeTags: ["logging"],
    supersedes: null,
    createdAt: "2026-09-20T00:00:00.000Z",
  });
}
function cap(overrides: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({
    id: "cap-core",
    name: "Core",
    summary: "The core module.",
    entryPoints: ["src/core"],
    contract: "Does the core thing.",
    checkedAt: { sha: "0".repeat(40), date: "2026-09-20" },
    ...overrides,
  });
}
function term(overrides: Record<string, unknown> = {}) {
  return TermSchema.parse({ id: "term-duet", term: "duet", definition: "Two sessions.", updatedAt: "2026-09-20T00:00:00.000Z", ...overrides });
}

describe("readLedgerSnapshot: typed file statuses", () => {
  it("ok, absent and unreadable are three different answers, and each family reports its own", async () => {
    const root = newRepo();
    write(root, `.story/rulings/${R1}.json`, ruling(R1));
    write(root, ".story/rulings/r-00000000000000zz.json", "{ not json");
    write(root, ".story/glossary.json", JSON.stringify({ version: 1, terms: [term()] }));
    write(root, ".story/capabilities.json", JSON.stringify({ version: 1, capabilities: [{ id: "cap-x" }] }));
    const oid = commit(root, "ledger");

    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.availability).toEqual({ kind: "ok" });
    expect(snap.commit).toBe(oid);
    expect(snap.filesystemChecks).toBe("working-tree");
    expect(snap.status(`.story/rulings/${R1}.json`)).toEqual({ kind: "ok" });
    expect(snap.status(".story/notes/N-1.json")).toEqual({ kind: "absent" });
    expect(snap.status(".story/rulings/r-00000000000000zz.json")).toEqual({ kind: "unreadable", reason: "not valid JSON" });
    // A schema mismatch names the code, never a byte of the file.
    const caps = snap.capabilities();
    expect(caps.kind).toBe("unreadable");
    expect(caps.kind === "unreadable" && caps.reason).toMatch(/^schema mismatch \(/);
    expect(snap.terms()).toMatchObject({ kind: "ok", entries: [{ id: "term-duet" }] });
    const rulings = snap.rulings();
    expect(rulings.records.map((r) => r.id)).toEqual([R1]);
    expect(rulings.unreadable).toEqual([{ path: ".story/rulings/r-00000000000000zz.json", reason: "not valid JSON" }]);
    // The unreadable ruling's id is recovered from its filename, as loadRulingsSafe does.
    const scan = snap.rulingsScan();
    expect([...scan.unavailableIds]).toEqual(["r-00000000000000zz"]);
    expect(scan.hasUnrecoverableEntries).toBe(false);
  });

  it("an absent catalog is absent, not unreadable; a missing commit is oid-unavailable for every family", async () => {
    const root = newRepo();
    write(root, "README.md", "x");
    const oid = commit(root, "no ledger");
    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.capabilities()).toEqual({ kind: "absent" });
    expect(snap.terms()).toEqual({ kind: "absent" });

    const gone = await readLedgerSnapshot(root, "f".repeat(40));
    expect(gone.availability.kind).toBe("oid-unavailable");
    expect(gone.capabilities().kind).toBe("oid-unavailable");
    expect(gone.status(".story/capabilities.json")).toEqual({ kind: "oid-unavailable" });
    expect(gone.rulings().available).toBe(false);
    expect(gone.rulingsScan().scanCompleteness).toBe("incomplete");

    const flag = await readLedgerSnapshot(root, "--all");
    expect(flag.availability.kind).toBe("oid-unavailable");
  });

  it("an oversized blob is refused from its listed size and never fetched", async () => {
    const root = newRepo();
    write(root, `.story/rulings/${R1}.json`, ruling(R1));
    write(root, ".story/notes/N-1.json", JSON.stringify({ id: "N-1", content: "x".repeat(SNAPSHOT_RECORD_MAX_BYTES) }));
    const oid = commit(root, "ledger");
    const bigBlob = git(root, ["rev-parse", `${oid}:.story/notes/N-1.json`]).trim();
    const batchInputs: string[] = [];
    const recording: SnapshotGitRunner = async (dir, args, input) => {
      if (args.includes("--batch")) batchInputs.push(input ?? "");
      const r = spawnSync("git", ["-C", dir, ...args], { input: input ?? "", env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString("utf-8") };
    };
    const snap = await readLedgerSnapshot(root, oid, recording);
    expect(snap.status(".story/notes/N-1.json")).toEqual({ kind: "unreadable", reason: `exceeds ${SNAPSHOT_RECORD_MAX_BYTES} bytes` });
    expect(snap.status(`.story/rulings/${R1}.json`)).toEqual({ kind: "ok" });
    expect(batchInputs.length).toBe(1);
    expect(batchInputs[0]).not.toContain(bigBlob);
  });

  it("reads the COMMITTED ledger, not the working tree, when the two disagree", async () => {
    const root = newRepo();
    write(root, `.story/rulings/${R1}.json`, ruling(R1, "committed text"));
    const oid = commit(root, "ledger");
    write(root, `.story/rulings/${R1}.json`, ruling(R1, "working tree text"));
    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.rulings().records[0]!.text).toBe("committed text");
  });

  it("a symlink in the ledger is unreadable, never followed and never absent", async () => {
    const root = newRepo();
    write(root, "outside.json", JSON.stringify({ version: 1, terms: [] }));
    mkdirSync(join(root, ".story"), { recursive: true });
    symlinkSync("../outside.json", join(root, ".story", "glossary.json"));
    const oid = commit(root, "symlinked glossary");
    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.terms()).toEqual({ kind: "unreadable", reason: "not a regular file" });
  });

  it("a file whose name does not match its ruling id is unreadable, as loadRulingsSafe skips it", async () => {
    const root = newRepo();
    write(root, ".story/rulings/r-0000000000000002.json", ruling(R1));
    const oid = commit(root, "misnamed");
    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.rulings().records).toEqual([]);
    expect(snap.rulings().unreadable[0]!.reason).toBe("filename does not match record id");
    // Both the filename id and the record's own id are unavailable, never unknown.
    expect([...snap.rulingsScan().unavailableIds].sort()).toEqual([R1, "r-0000000000000002"]);
    write(root, "src/core/a.ts", "a");
    const report = await checkCapabilities(root, [cap({ rulings: [R1] })], null, { skipFreshness: true, snapshot: snap });
    expect(report.entries[0]!.results.map((r) => r.code)).toEqual(["capability_check_incomplete"]);
  });
});

describe("checkCapabilities with a snapshot (3.2 checker amendment)", () => {
  it("resolves ruling references against the snapshot commit, and says the filesystem checks were the working tree", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "a");
    write(root, `.story/rulings/${R1}.json`, ruling(R1));
    const withRuling = commit(root, "ruling exists");
    unlinkSync(join(root, ".story", "rulings", `${R1}.json`));
    commit(root, "ruling deleted");

    const entry = cap({ rulings: [R1], checkedAt: { sha: withRuling, date: "2026-09-20" } });
    const live = await checkCapabilities(root, [entry], null, { skipFreshness: true });
    expect(live.entries[0]!.results.map((r) => r.code)).toEqual(["capability_unknown_ruling"]);
    expect(live.filesystemChecks).toBeUndefined();

    const snap = await readLedgerSnapshot(root, withRuling);
    const historical = await checkCapabilities(root, [entry], null, { skipFreshness: true, snapshot: snap });
    expect(historical.entries[0]!.results).toEqual([]);
    expect(historical.filesystemChecks).toBe("working-tree");
    expect(historical.snapshotCommit).toBe(withRuling);
  });

  it("an unavailable snapshot makes a missing reference incomplete, never unknown", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "a");
    commit(root, "base");
    const snap = await readLedgerSnapshot(root, "e".repeat(40));
    const report = await checkCapabilities(root, [cap({ rulings: [R1], items: ["T-1"], terms: ["term-x"] })], null, { skipFreshness: true, snapshot: snap });
    const codes = report.entries[0]!.results.map((r) => r.code);
    expect(codes).not.toContain("capability_unknown_ruling");
    expect(codes).not.toContain("capability_unknown_item");
    expect(codes).not.toContain("capability_unknown_term");
    expect(codes.every((c) => c === "capability_check_incomplete")).toBe(true);
    expect(codes).toHaveLength(3);
  });

  it("items resolve from the snapshot's tickets in either id form", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "a");
    write(
      root,
      ".story/tickets/t-00000000000000ab.json",
      JSON.stringify({ id: "t-00000000000000ab", displayId: "T-7", title: "x", description: "", type: "task", status: "open", phase: null, order: 10, createdDate: "2026-09-20", completedDate: null, blockedBy: [], parentTicket: null }),
    );
    const oid = commit(root, "ticket");
    const snap = await readLedgerSnapshot(root, oid);
    expect(snap.tickets().unreadable).toEqual([]);
    const report = await checkCapabilities(root, [cap({ items: ["T-7", "t-00000000000000ab", "T-8"] })], null, { skipFreshness: true, snapshot: snap });
    expect(report.entries[0]!.results.map((r) => r.detail)).toEqual(["unknown item: T-8"]);
  });

  it("computes freshness against headOid instead of HEAD", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    const changed = commit(root, "change");
    write(root, "src/core/a.ts", "three");
    commit(root, "later");
    const entry = cap({ checkedAt: { sha: base, date: "2026-09-20" } });
    const atBase = await checkCapabilities(root, [entry], null, { headOid: base });
    expect(atBase.head).toBe(base);
    expect(atBase.entries[0]!.effectiveStatus).toBe("current");
    const atChanged = await checkCapabilities(root, [entry], null, { headOid: changed });
    expect(atChanged.head).toBe(changed);
    expect(atChanged.entries[0]!.results.map((r) => r.code)).toEqual(["capability_changed"]);
    const bad = await checkCapabilities(root, [entry], null, { headOid: "--output=x" });
    expect(bad.head).toBeNull();
    expect(bad.unchecked).toEqual(["cap-core"]);
  });
});

describe("checkTerms with a snapshot-fed index", () => {
  it("resolves capability links against the snapshot's catalog, and an unreadable one is taint", async () => {
    const root = newRepo();
    write(root, ".story/capabilities.json", JSON.stringify({ version: 1, capabilities: [cap({ id: "cap-then" })] }));
    const then = commit(root, "catalog");
    write(root, ".story/capabilities.json", "{ broken");
    const broken = commit(root, "broken catalog");
    const entries = [term({ capabilities: ["cap-then"], distinction: "not a solo" })];

    const good = checkTerms(entries, buildTermReferenceIndexFromSnapshot(await readLedgerSnapshot(root, then)));
    expect(good.errorIds).toEqual([]);
    expect(good.incompleteIds).toEqual([]);
    expect(good.filesystemChecks).toBe("working-tree");

    const tainted = checkTerms(entries, buildTermReferenceIndexFromSnapshot(await readLedgerSnapshot(root, broken)));
    expect(tainted.errorIds).toEqual([]);
    expect(tainted.incompleteIds).toEqual(["term-duet"]);

    // The working-tree index is untouched by the amendment and says nothing about a snapshot.
    const live = checkTerms(entries, buildTermReferenceIndex(root, { ids: ["cap-then"], incomplete: false }));
    expect(live.filesystemChecks).toBeUndefined();
  });
});
