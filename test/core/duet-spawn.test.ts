import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, realpathSync, readdirSync, symlinkSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  spawnWorker, buildWorkerCommand, shellQuote, defaultWorkerRole, validateWorkerName, resolvePermissionMode, detectPenPermissionMode,
  detectPenPermissionModeWith, classifyClaudeCommand, psProcessReader, parsePsLine, prepareSpawnDir, writeSpawnJournal, readSpawnJournal,
  mintWorkerTaskId, validateWorkerTaskId, resolveWorkerDir, permissionModeReason, ledgerParagraph,
  resolveWorkerModel, workerModelReason, DEFAULT_WORKER_MODEL,
  type Launcher, type ProcessReader, type SpawnHandshake, type SpawnStage,
} from "../../src/core/duet-spawn.js";
import { initProject, STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";
import { scanSessionSummaries } from "../../src/core/session-scan.js";
import { evaluateSessionGuard, completenessFromDiagnostics } from "../../src/core/session-guard.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "duet-spawn-"));
  mkdirSync(join(root, ".story"), { recursive: true });
  // ISS-1305: the pen's project must resolve (the same test discoverProjectRoot uses).
  writeFileSync(join(root, ".story", "config.json"), "{}\n");
  return root;
}

const noPen = () => null;
const HANDSHAKE: SpawnHandshake = {
  penTaskId: "11111111-2222-4333-8444-555555555555",
  penClient: "claude",
  arrangementId: "a-0123456789abcdef",
  coordinationSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  nonce: "99999999-8888-4777-8666-555555555555",
};

/** Everything spawnWorker needs beyond the user-facing options: the handler prepares these before any ledger write. */
function prep(root: string, name: string, dir?: string) {
  const spawnDir = prepareSpawnDir(root, name);
  const stages: SpawnStage[] = [];
  const journalPath = join(spawnDir, `${name}.json`);
  const journal = (stage: SpawnStage, extra: Record<string, unknown> = {}) => { stages.push(stage); writeSpawnJournal(journalPath, { stage, ...extra }); };
  const w = resolveWorkerDir(root, dir);
  return { spawnDir, journalPath, journal, stages, workerTaskId: mintWorkerTaskId(), penProjectRoot: root, workerDir: w.workerDir, workerProjectRoot: w.workerProjectRoot };
}

describe("N-131 / T-530: storybloq duet spawn", () => {
  it("writes an executable launch script, a role naming the pen, and a journal under .story/spawn/; the injected launcher receives the script", () => {
    const root = project();
    const calls: Array<[string, string | undefined]> = [];
    const launcher: Launcher = (script, terminal) => { calls.push([script, terminal]); return "fake-open"; };
    const p = prep(root, "cpm-w2");
    const r = spawnWorker(root, { name: "cpm-w2", pen: "cpm-00", model: "opus", ...p }, launcher, noPen);
    expect(r.launch).toBe("opened");
    expect(r.launcher).toBe("fake-open");
    expect(calls).toEqual([[r.scriptPath, undefined]]);
    expect(dirname(dirname(r.scriptPath))).toBe(join(root, ".story", "spawn"));
    expect(basename(dirname(r.scriptPath))).toMatch(/^cpm-w2\..+$/);
    expect(basename(r.scriptPath)).toBe("cpm-w2.command");
    expect(statSync(r.scriptPath).mode & 0o111).not.toBe(0);
    const script = readFileSync(r.scriptPath, "utf-8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`cd '${root}' || exit 1`);
    expect(script).toContain(`exec claude -n 'cpm-w2' --session-id '${p.workerTaskId}' --model 'opus' --permission-mode 'auto' --append-system-prompt-file '${r.rolePath}' '/story'`);
    const role = readFileSync(r.rolePath, "utf-8");
    expect(role).toContain("named `cpm-00`");
    expect(role).toContain("Do not start work on your own");
    expect(role).toContain("turn ending, continue needed");
    expect(r.workerTaskId).toBe(p.workerTaskId);
    expect(r.autoLoad).toBe(true);
    expect(r.handshake).toBeNull();
    expect(r.roleSource).toBe("generated");
    expect(r.command).toBe(`cd '${root}' && env -u STORYBLOQ_PROJECT_ROOT -u CLAUDESTORY_PROJECT_ROOT claude -n 'cpm-w2' --session-id '${p.workerTaskId}' --model 'opus' --permission-mode 'auto' --append-system-prompt-file '${r.rolePath}' '/story'`);
    // the journal advanced through artifacts, launch-attempted and launched, in that order, and never carried a nonce
    expect(p.stages).toEqual(["artifacts", "launch-attempted", "launched"]);
    expect(readSpawnJournal(p.journalPath)).toMatchObject({ stage: "launched", launcher: "fake-open" });
    expect(readFileSync(p.journalPath, "utf-8")).not.toContain("nonce");
    // no .tmp left behind by the atomic writer
    expect(readdirSync(p.spawnDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("the script actually runs: with a stub `claude` on PATH it cds into the dir and passes the exact arguments, /story last", () => {
    const root = project();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "claude.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\npwd > '${log}'\nprintf '%s\\n' "$@" >> '${log}'\n`);
    execFileSync("chmod", ["755", join(bin, "claude")]);
    const p = prep(root, "w1");
    const r = spawnWorker(root, { name: "w1", pen: "p1", ...p }, () => null, noPen);
    execFileSync(r.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(realpathSync(lines[0]!)).toBe(realpathSync(root));
    expect(lines.slice(1)).toEqual(["-n", "w1", "--session-id", p.workerTaskId, "--model", "opus", "--permission-mode", "auto", "--append-system-prompt-file", r.rolePath, "/story"]);
    // --no-auto-load drops the prompt and nothing else moves
    const q = prep(root, "w1b");
    const r2 = spawnWorker(root, { name: "w1b", pen: "p1", autoLoad: false, ...q }, () => null, noPen);
    execFileSync(r2.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(log, "utf-8").trim().split("\n").slice(1)).toEqual(["-n", "w1b", "--session-id", q.workerTaskId, "--model", "opus", "--permission-mode", "auto", "--append-system-prompt-file", r2.rolePath]);
    expect(r2.autoLoad).toBe(false);
  });

  it("a launcher that has no handler reports printed and the journal stays at launch-attempted; a launcher that throws propagates after launch-attempted was journaled", () => {
    const root = project();
    const p = prep(root, "w2");
    const none = spawnWorker(root, { name: "w2", pen: "p", ...p }, () => null, noPen);
    expect(none.launch).toBe("printed");
    expect(none.launcher).toBeNull();
    expect(existsSync(none.scriptPath)).toBe(true);
    // no OS launcher is not a launch: the journal says so (byte-review F8)
    expect(p.stages).toEqual(["artifacts", "launch-attempted", "launch-manual"]);
    expect(readSpawnJournal(p.journalPath)).toMatchObject({ stage: "launch-manual", launcher: null, launch: "printed" });
    const q = prep(root, "w3");
    let handed: string | null = null;
    expect(() => spawnWorker(root, { name: "w3", pen: "p", ...q }, (script) => { handed = script; throw new Error("open failed"); }, noPen)).toThrow(/open failed/);
    expect(handed).not.toBeNull();
    expect(q.stages).toEqual(["artifacts", "launch-attempted"]);
    expect(readSpawnJournal(q.journalPath)).toMatchObject({ stage: "launch-attempted" });
  });

  it("worker task ids are minted as lowercase uuid v4 and anything else is refused", () => {
    const id = mintWorkerTaskId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mintWorkerTaskId()).not.toBe(id);
    expect(() => validateWorkerTaskId(id)).not.toThrow();
    expect(() => validateWorkerTaskId("cpm-w4")).toThrow(/uuid/i);
    expect(() => validateWorkerTaskId(id.toUpperCase())).toThrow(/uuid/i);
    expect(() => validateWorkerTaskId("11111111-2222-1333-8444-555555555555")).toThrow(/uuid/i);
    expect(() => validateWorkerTaskId("")).toThrow(/uuid/i);
    const root = project();
    const p = prep(root, "w");
    expect(() => spawnWorker(root, { name: "w", pen: "p", ...p, workerTaskId: "not-a-uuid" }, () => null, noPen)).toThrow(/uuid/i);
  });

  it("with handshake facts the role carries the arrangement, session, nonce, both identities and the exact echo line; without them it keeps the wait text", () => {
    const root = project();
    const p = prep(root, "w");
    const r = spawnWorker(root, { name: "w", pen: "pen-1", handshake: HANDSHAKE, ...p }, () => null, noPen);
    const role = readFileSync(r.rolePath, "utf-8");
    expect(role).toContain("## Handshake");
    expect(role).toContain(HANDSHAKE.arrangementId);
    expect(role).toContain(HANDSHAKE.coordinationSessionId);
    expect(role).toContain(HANDSHAKE.nonce);
    expect(role).toContain(`pen-1`);
    expect(role).toContain(HANDSHAKE.penTaskId);
    expect(role).toContain(p.workerTaskId);
    expect(role).toContain(`nonce ${HANDSHAKE.nonce}, worker w ${p.workerTaskId.slice(0, 8)}, sender <your exact sender tool name>`);
    expect(role).toContain("right after `/story` finishes loading");
    expect(role).not.toContain("wait for the pen's handshake");
    expect(role).toContain("if present");
    expect(role).toContain("background jobs");
    expect(r.handshake).toEqual(HANDSHAKE);
    const q = prep(root, "w2");
    const plain = readFileSync(spawnWorker(root, { name: "w2", pen: "pen-1", ...q }, () => null, noPen).rolePath, "utf-8");
    expect(plain).toContain("wait for the pen's handshake");
    expect(plain).not.toContain("## Handshake");
    expect(defaultWorkerRole("pen", "w", { workerDir: root, penProjectRoot: root, workerProjectRoot: root, workerTaskId: p.workerTaskId })).toContain("# Duet worker w");
  });

  it("the role says where the ledger and the arrangement live, decided by resolved project root, not by path", async () => {
    const pen = mkdtempSync(join(tmpdir(), "duet-pen-"));
    await initProject(pen, { name: "pen" });
    const other = mkdtempSync(join(tmpdir(), "duet-node-"));
    await initProject(other, { name: "node" });
    mkdirSync(join(pen, "sub", "deeper"), { recursive: true });
    const alias = join(mkdtempSync(join(tmpdir(), "duet-alias-")), "link");
    symlinkSync(pen, alias);
    const same = (dir: string) => {
      const p = prep(pen, "w", dir);
      return readFileSync(spawnWorker(pen, { name: "w", pen: "p", dir, handshake: HANDSHAKE, ...p }, () => null, noPen).rolePath, "utf-8");
    };
    for (const dir of [pen, join(pen, "sub", "deeper"), alias]) {
      const role = same(dir);
      expect(role).toContain("resolves to the pen's ledger");
      expect(role).not.toContain("cannot read it from here");
    }
    const cross = same(other);
    expect(cross).toContain(`loads the ledger at ${realpathSync(other)}`);
    expect(cross).toContain("cannot read it from here");
    expect(cross).toContain("bounds are coverage");
    // a custom role into another project still learns where the arrangement lives (byte-review F7)
    writeFileSync(join(pen, "custom.md"), "my role");
    const pc = prep(pen, "wc", other);
    const customCross = readFileSync(spawnWorker(pen, { name: "wc", pen: "p", dir: other, role: "custom.md", handshake: HANDSHAKE, ...pc }, () => null, noPen).rolePath, "utf-8");
    expect(customCross.startsWith("my role\n\n## Ledger")).toBe(true);
    expect(customCross).toContain(`loads the ledger at ${realpathSync(other)}`);
    expect(customCross).toContain(`pen's board at ${realpathSync(pen)}`);
    expect(customCross).toContain("## Handshake");
    expect(ledgerParagraph({ workerDir: other, penProjectRoot: pen, workerProjectRoot: realpathSync(other), workerTaskId: pc.workerTaskId })).toContain("cannot read it from here");
    // resolution facts
    expect(resolveWorkerDir(pen, join(pen, "sub", "deeper"))).toEqual({ workerDir: join(pen, "sub", "deeper"), workerProjectRoot: realpathSync(pen) });
    expect(resolveWorkerDir(pen, alias).workerProjectRoot).toBe(realpathSync(pen));
    expect(resolveWorkerDir(pen, other).workerProjectRoot).toBe(realpathSync(other));
    const bare = mkdtempSync(join(tmpdir(), "duet-bare-"));
    expect(resolveWorkerDir(pen, bare)).toEqual({ workerDir: bare, workerProjectRoot: null });
    expect(() => resolveWorkerDir(pen, join(pen, "missing"))).toThrow(/does not exist/);
    expect(resolveWorkerDir(pen, "sub").workerDir).toBe(join(pen, "sub"));
  });

  it("a custom role file is used as given and must exist; with a handshake it is combined into the spawn dir and never modified; --terminal reaches the launcher", () => {
    const root = project();
    const role = join(root, "role.md");
    writeFileSync(role, "custom role");
    const seen: Array<string | undefined> = [];
    mkdirSync(join(root, "sub"));
    const p = prep(root, "w", "sub");
    const r = spawnWorker(root, { name: "w", pen: "p", role: "role.md", dir: "sub", terminal: "Ghostty", ...p }, (_s, t) => { seen.push(t); return "open -a"; }, noPen);
    expect(r.rolePath).toBe(role);
    expect(r.roleSource).toBe("custom");
    expect(readFileSync(r.scriptPath, "utf-8")).toContain(`cd '${join(root, "sub")}' || exit 1`);
    expect(seen).toEqual(["Ghostty"]);
    const q = prep(root, "w2");
    const combined = spawnWorker(root, { name: "w2", pen: "p", role: "role.md", handshake: HANDSHAKE, ...q }, () => null, noPen);
    expect(combined.roleSource).toBe("custom+handshake");
    expect(combined.rolePath).toBe(join(q.spawnDir, "w2-role.md"));
    const text = readFileSync(combined.rolePath, "utf-8");
    expect(text.startsWith("custom role\n\n## Ledger\n\n")).toBe(true);
    expect(text).toContain("## Handshake");
    expect(text).toContain(HANDSHAKE.nonce);
    expect(text).toContain("resolves to the pen's ledger");
    expect(readFileSync(role, "utf-8")).toBe("custom role");
    expect(readFileSync(combined.scriptPath, "utf-8")).toContain(`--append-system-prompt-file '${combined.rolePath}'`);
    const m = prep(root, "w3");
    expect(() => spawnWorker(root, { name: "w3", pen: "p", role: "missing.md", ...m }, () => null, noPen)).toThrow(/ENOENT/);
  });

  it("names are validated and the worker may not be the pen; shell quoting survives a quote", () => {
    const root = project();
    const p = prep(root, "ok");
    expect(() => spawnWorker(root, { name: "bad name", pen: "p", ...p }, () => null, noPen)).toThrow(/Invalid worker name/);
    expect(() => spawnWorker(root, { name: "../x", pen: "p", ...p }, () => null, noPen)).toThrow(/Invalid worker name/);
    expect(() => spawnWorker(root, { name: "same", pen: "same", ...p }, () => null, noPen)).toThrow(/must differ/);
    expect(() => prepareSpawnDir(root, "../x")).toThrow(/Invalid worker name/);
    expect(() => validateWorkerName("ok-1.a_b")).not.toThrow();
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const id = mintWorkerTaskId();
    // ISS-1303: an absent or empty model is the hands tier, never the client default.
    expect(buildWorkerCommand({ name: "n", workerTaskId: id, rolePath: "/r x.md", autoLoad: true })).toBe(`claude -n 'n' --session-id '${id}' --model 'opus' --append-system-prompt-file '/r x.md' '/story'`);
    expect(buildWorkerCommand({ name: "n", workerTaskId: id, model: "", rolePath: "/r", autoLoad: false })).toBe(`claude -n 'n' --session-id '${id}' --model 'opus' --append-system-prompt-file '/r'`);
  });

  // ISS-1289: the spawn dir used to live under .story/sessions/, where the
  // session scanner read it as a state-less session and the guard went
  // unverifiable for an hour. It now lives beside sessions/, protected by its
  // own .gitignore so an existing project's .story/.gitignore need not know it.
  it("spawning leaves the session scan complete and the guard free, and the artifacts are git-ignored even when .story/.gitignore lacks spawn/", async () => {
    const root = mkdtempSync(join(tmpdir(), "duet-guard-"));
    await initProject(root, { name: "g" });
    writeFileSync(join(root, ".story", ".gitignore"), "sessions/\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const p = prep(root, "w");
    const r = spawnWorker(root, { name: "w", pen: "p", ...p }, () => null, noPen);
    expect(readFileSync(join(root, ".story", "spawn", ".gitignore"), "utf-8")).toBe("*\n");
    const ignored = execFileSync("git", ["check-ignore", r.scriptPath, r.rolePath, p.journalPath], { cwd: root, encoding: "utf-8" }).trim().split("\n");
    expect(ignored).toHaveLength(3);
    expect(existsSync(join(root, ".story", "sessions", "spawn"))).toBe(false);
    const scan = scanSessionSummaries(root);
    expect(scan.diagnostics ?? []).toEqual([]);
    expect(completenessFromDiagnostics(scan.diagnostics ?? [])).toBe("complete");
    expect(evaluateSessionGuard(root, { client: "claude" }).overallAction).toBe("free");
    expect(STORY_GITIGNORE_ENTRIES).toContain("spawn/");
    // a second prepare on the same project is idempotent about the .gitignore
    prepareSpawnDir(root, "w");
    expect(readFileSync(join(root, ".story", "spawn", ".gitignore"), "utf-8")).toBe("*\n");
  });

  // Byte-review (Codex, 2026-09-22, security): containment used to be checked
  // after mkdir, the .gitignore write and mkdtemp, so a symlink planted at
  // .story/spawn or .story/spawn/.gitignore could redirect a write outside the
  // project before the check ran. Every component is lstat-checked first now.
  it("a symlinked .story/spawn or .gitignore is refused before anything is created, and the symlink targets stay untouched", () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "duet-outside-"));
    symlinkSync(outside, join(root, ".story", "spawn"));
    expect(() => prepareSpawnDir(root, "w")).toThrow(/not a directory \(symlinks are not followed\)/);
    expect(readdirSync(outside)).toEqual([]);
    const root2 = project();
    mkdirSync(join(root2, ".story", "spawn"));
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, join(root2, ".story", "spawn", ".gitignore"));
    expect(() => prepareSpawnDir(root2, "w")).toThrow(/not a regular file \(symlinks are not followed\)/);
    expect(readFileSync(victim, "utf-8")).toBe("keep me");
    expect(readdirSync(join(root2, ".story", "spawn"))).toEqual([".gitignore"]);
    const root3 = mkdtempSync(join(tmpdir(), "duet-nostory-"));
    symlinkSync(outside, join(root3, ".story"));
    expect(() => prepareSpawnDir(root3, "w")).toThrow(/not a directory \(symlinks are not followed\)/);
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
  });

  // Byte-review round 2 (and round 3's minor): two first-time spawns racing on
  // an absent .story/spawn must both succeed. Each hook fires AFTER the absence
  // check and immediately BEFORE its create, so the caller under test really
  // meets EEXIST on that entry; removing either handler fails its case.
  it("a concurrent first spawn that loses the mkdir race, and one that loses the .gitignore race, both succeed with their own directory", () => {
    const root = project();
    const spawnRoot = join(root, ".story", "spawn");
    let mkdirRaced = 0;
    const dir = prepareSpawnDir(root, "w", { beforeMkdir: () => { mkdirRaced++; mkdirSync(spawnRoot); } });
    expect(mkdirRaced).toBe(1);
    expect(dirname(dir)).toBe(spawnRoot);
    expect(readFileSync(join(spawnRoot, ".gitignore"), "utf-8")).toBe("*\n");
    const root2 = project();
    const spawnRoot2 = join(root2, ".story", "spawn");
    let ignoreRaced = 0;
    const dir2 = prepareSpawnDir(root2, "w", { beforeIgnoreWrite: () => { ignoreRaced++; writeFileSync(join(spawnRoot2, ".gitignore"), "*\n"); } });
    expect(ignoreRaced).toBe(1);
    expect(dirname(dir2)).toBe(spawnRoot2);
    // a winner that planted the wrong kind of entry is still refused after the EEXIST
    const root3 = project();
    const outside = mkdtempSync(join(tmpdir(), "duet-outside2-"));
    expect(() => prepareSpawnDir(root3, "w", { beforeMkdir: () => symlinkSync(outside, join(root3, ".story", "spawn")) })).toThrow(/not a directory/);
    expect(readdirSync(outside)).toEqual([]);
    const root4 = project();
    mkdirSync(join(root4, ".story", "spawn"));
    const victim = join(outside, "v.txt"); writeFileSync(victim, "keep");
    expect(() => prepareSpawnDir(root4, "w", { beforeIgnoreWrite: () => symlinkSync(victim, join(root4, ".story", "spawn", ".gitignore")) })).toThrow(/not a regular file/);
    expect(readFileSync(victim, "utf-8")).toBe("keep");
  });

  it("the journal writer is atomic: the file is either the previous entry or the new one, never partial, and a read of a missing or malformed journal is null", () => {
    const root = project();
    const dir = prepareSpawnDir(root, "j");
    const path = join(dir, "j.json");
    expect(readSpawnJournal(path)).toBeNull();
    writeSpawnJournal(path, { stage: "intent", workerTaskId: "x" });
    expect(readSpawnJournal(path)).toEqual({ stage: "intent", workerTaskId: "x" });
    writeSpawnJournal(path, { stage: "created", arrangementId: "a-1" });
    expect(readSpawnJournal(path)).toEqual({ stage: "created", arrangementId: "a-1" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    writeFileSync(path, "{not json");
    expect(readSpawnJournal(path)).toBeNull();
    // Byte-review F10: a failure between the temp write and the rename leaves the
    // destination exactly as it was and the temp file gone; the temp file is
    // fsynced before the rename. A direct destination write could not pass this.
    writeSpawnJournal(path, { stage: "artifacts" });
    let fsynced = 0;
    expect(() => writeSpawnJournal(path, { stage: "launched" }, { fsync: () => { fsynced++; }, rename: () => { throw new Error("rename refused"); } })).toThrow(/rename refused/);
    expect(fsynced).toBe(1);
    expect(readSpawnJournal(path)).toEqual({ stage: "artifacts" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const order: string[] = [];
    writeSpawnJournal(path, { stage: "launched" }, { fsync: () => { order.push("fsync"); }, rename: (a, b) => { order.push("rename"); renameSync(a, b); } });
    expect(order).toEqual(["fsync", "rename"]);
    expect(readSpawnJournal(path)).toEqual({ stage: "launched" });
  });

  it("--permission-mode reaches the argv exactly and is validated; absent means auto unless the pen is in bypass; each source has a plain reason", () => {
    const root = project();
    const p = prep(root, "w");
    const r = spawnWorker(root, { name: "w", pen: "p", permissionMode: "bypassPermissions", ...p }, () => null);
    expect(readFileSync(r.scriptPath, "utf-8")).toContain(`--permission-mode 'bypassPermissions' --append-system-prompt-file`);
    expect(r.permissionMode).toBe("bypassPermissions");
    expect(r.permissionModeSource).toBe("explicit");
    expect(r.permissionModeReason).toBe(permissionModeReason("explicit"));
    const bin = join(root, "bin"); mkdirSync(bin);
    const log = join(root, "argv.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    execFileSync("chmod", ["755", join(bin, "claude")]);
    execFileSync(r.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual(["-n", "w", "--session-id", p.workerTaskId, "--model", "opus", "--permission-mode", "bypassPermissions", "--append-system-prompt-file", r.rolePath, "/story"]);
    const q = prep(root, "w2");
    expect(() => spawnWorker(root, { name: "w2", pen: "p", permissionMode: "yolo", ...q }, () => null)).toThrow(/Unknown permission mode/);
    const s = prep(root, "w3");
    const plain = spawnWorker(root, { name: "w3", pen: "p", ...s }, () => null, noPen);
    expect(readFileSync(plain.scriptPath, "utf-8")).toContain("--permission-mode 'auto'");
    expect(plain.permissionModeSource).toBe("default");
    expect(plain.permissionModeReason).toMatch(/product default/);
    expect(permissionModeReason("inherited-bypass")).toMatch(/pen runs in bypass/);
    expect(permissionModeReason("explicit")).toMatch(/as given/);
  });

  // Review finding (Codex, 2026-09-22), category: race. A second spawn with the
  // same name used to overwrite the script, role and record of the first while
  // `open` might not have read them yet. Every invocation now owns its files.
  it("two spawns with the same name never share or overwrite an artifact", () => {
    const root = project();
    const pa = prep(root, "w");
    const a = spawnWorker(root, { name: "w", pen: "p", model: "sonnet", ...pa }, () => null, noPen);
    mkdirSync(join(root, "elsewhere"));
    const pb = prep(root, "w", "elsewhere");
    const b = spawnWorker(root, { name: "w", pen: "p", model: "opus", dir: "elsewhere", ...pb }, () => null, noPen);
    expect(a.scriptPath).not.toBe(b.scriptPath);
    expect(a.rolePath).not.toBe(b.rolePath);
    expect(pa.journalPath).not.toBe(pb.journalPath);
    expect(a.workerTaskId).not.toBe(b.workerTaskId);
    expect(readFileSync(a.scriptPath, "utf-8")).toContain("--model 'sonnet'");
    expect(readFileSync(a.scriptPath, "utf-8")).toContain(`cd '${root}'`);
    expect(readFileSync(b.scriptPath, "utf-8")).toContain("--model 'opus'");
  });

  // Owner ruling (2026-09-22): the product default is auto; bypass is inherited
  // only when the pen itself runs in bypass, never assumed. Detection reads the
  // pen's claude argv from the process tree; an unreadable tree is "unknown".
  it("the worker inherits bypass only from a bypass pen; an explicit mode always wins; an unknown pen means auto", () => {
    expect(resolvePermissionMode(undefined, () => "bypassPermissions")).toEqual({ mode: "bypassPermissions", source: "inherited-bypass" });
    expect(resolvePermissionMode(undefined, () => "default")).toEqual({ mode: "auto", source: "default" });
    expect(resolvePermissionMode(undefined, () => null)).toEqual({ mode: "auto", source: "default" });
    expect(resolvePermissionMode("plan", () => "bypassPermissions")).toEqual({ mode: "plan", source: "explicit" });
    const root = project();
    const p = prep(root, "w");
    const r = spawnWorker(root, { name: "w", pen: "p", ...p }, () => null, () => "bypassPermissions");
    expect(readFileSync(r.scriptPath, "utf-8")).toContain("--permission-mode 'bypassPermissions'");
    expect(r.permissionModeSource).toBe("inherited-bypass");
    // The real detector never throws; from this test process the nearest claude ancestor, if any, is a real session.
    const seen = detectPenPermissionMode();
    expect(seen === null || typeof seen === "string").toBe(true);
  });

  // Review findings (Codex, 2026-09-22): ps flattens argv, so a flag inside
  // prompt text used to read as the pen's flag (critical), and a node-wrapped
  // claude was not recognised (major). Only an allowlisted line is trusted, the
  // nearest Claude process decides, and every failure is "unknown".
  it("classifies command lines by allowlisted tokens only; free text, prompts, subcommands and non-claude processes never yield bypass", () => {
    const c = classifyClaudeCommand;
    expect(c("claude --dangerously-skip-permissions")).toEqual({ session: true, mode: "bypassPermissions" });
    expect(c("/Users/me/.local/bin/claude --permission-mode bypassPermissions")).toEqual({ session: true, mode: "bypassPermissions" });
    expect(c("/Users/me/.local/share/claude/versions/2.1.280 --dangerously-skip-permissions")).toEqual({ session: true, mode: "bypassPermissions" });
    expect(c("claude --permission-mode acceptEdits --verbose")).toEqual({ session: true, mode: "acceptEdits" });
    expect(c("claude")).toEqual({ session: true, mode: "default" });
    expect(c("claude --continue")).toEqual({ session: true, mode: "default" });
    expect(c("node /Users/me/.local/share/claude/versions/2.1.280 --dangerously-skip-permissions")).toEqual({ session: true, mode: "bypassPermissions" });
    expect(c("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --permission-mode plan")).toEqual({ session: true, mode: "plan" });
    // the last mode option wins, and only when the whole line is allowlisted tokens
    expect(c("claude --permission-mode bypassPermissions --verbose --permission-mode default")).toEqual({ session: true, mode: "default" });
    expect(c("claude --permission-mode acceptEdits -c --dangerously-skip-permissions")).toEqual({ session: true, mode: "bypassPermissions" });
    // anything not on the allowlist, anywhere, makes the line unknown, even after a bypass flag
    expect(c("claude --dangerously-skip-permissions -n cpm-w3 --model sonnet")).toEqual({ session: true, mode: null });
    expect(c("claude -n cpm-w3 --model sonnet --permission-mode bypassPermissions")).toEqual({ session: true, mode: null });
    expect(c("claude --debug-file --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --system-prompt hello --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --system-prompt hello there --dangerously-skip-permissions more")).toEqual({ session: true, mode: null });
    expect(c("claude --system-prompt=x --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --unknown-opt=--dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --dangerously-skip-permissions --unknown-flag")).toEqual({ session: true, mode: null });
    expect(c("claude fix the bug --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --permission-mode bypassPermissions mcp list")).toEqual({ session: true, mode: null });
    expect(c("claude -- --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude mcp list --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --permission-mode yolo")).toEqual({ session: true, mode: null });
    expect(c("claude --permission-mode")).toEqual({ session: true, mode: null });
    expect(c("claude --permission-mode=bypassPermissions")).toEqual({ session: true, mode: null });
    // not claude at all, including look-alikes
    expect(c("/bin/zsh -c claude --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("node /srv/app/server.js --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("node /tmp/notclaude/cli.js --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("node /tmp/claude-helper/cli.js --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("node /x/@anthropic-ai/claude-code/cli.js.backup --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("node /x/claude/versions/2.1.280/../evil --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("claude-companion --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("/x/claude/versions/notes.txt --dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("")).toEqual({ session: false, mode: null });
  });

  // Codex post-ship review (2026-09-22, critical): ps flattens argv, so a pen
  // started as `claude ' --dangerously-skip-permissions'` (one positional
  // prompt argument) prints as `claude  --dangerously-skip-permissions` and
  // read as bypass. Whitespace inside an argument always leaves a doubled,
  // leading or trailing space (tabs are escaped by ps on macOS and are not a
  // space anyway), so any such line is a session of unknown mode.
  it("an argument that merely contains a bypass flag never yields bypass: doubled, leading or trailing spaces and tabs mean unknown", () => {
    const c = classifyClaudeCommand;
    expect(c("claude  --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --dangerously-skip-permissions ")).toEqual({ session: true, mode: null });
    expect(c(" claude --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    expect(c("claude --permission-mode  bypassPermissions")).toEqual({ session: true, mode: null });
    expect(c("claude\t--dangerously-skip-permissions")).toEqual({ session: false, mode: null });
    expect(c("claude --dangerously-skip-permissions\t")).toEqual({ session: true, mode: null });
    expect(c("node  /x/@anthropic-ai/claude-code/cli.js --dangerously-skip-permissions")).toEqual({ session: true, mode: null });
    // the parser keeps the command's spacing intact for the classifier
    expect(parsePsLine("  123 claude  --dangerously-skip-permissions\n")).toEqual({ ppid: 123, command: "claude  --dangerously-skip-permissions" });
    expect(parsePsLine("123 claude --dangerously-skip-permissions \n")).toEqual({ ppid: 123, command: "claude --dangerously-skip-permissions " });
    expect(c("claude --dangerously-skip-permissions")).toEqual({ session: true, mode: "bypassPermissions" });
  });

  // T-530: the spawned worker's own command line now carries `-n`, `--session-id`
  // and a positional `/story`, none of which is on the allowlist, so a worker
  // that itself spawns a worker is an unknown pen (auto), never an inherited
  // bypass read off the grandparent.
  it("a T-530 worker command line is a session of unknown mode, so a spawn from inside a worker defaults to auto", () => {
    const line = `claude -n cpm-w4 --session-id ${randomUUID()} --model opus --permission-mode bypassPermissions --append-system-prompt-file /x/role.md /story`;
    expect(classifyClaudeCommand(line)).toEqual({ session: true, mode: null });
    const tree = (rows: Record<number, { ppid: number; command: string }>): ProcessReader => (pid) => rows[pid] ?? null;
    const nested = tree({ 100: { ppid: 90, command: "sh" }, 90: { ppid: 80, command: line }, 80: { ppid: 1, command: "claude --dangerously-skip-permissions" } });
    expect(detectPenPermissionModeWith(nested, 100)).toBeNull();
    expect(resolvePermissionMode(undefined, () => detectPenPermissionModeWith(nested, 100)).mode).toBe("auto");
  });

  it("through the production ps reader, a real bypass flag and a one-argument prompt with the same text are told apart", () => {
    // A node script at Claude Code's installed cli.js path (a node-entry the classifier
    // accepts) ignores its argv and stays alive; node is present wherever vitest runs.
    const dir = mkdtempSync(join(tmpdir(), "duet-argv-"));
    mkdirSync(join(dir, "@anthropic-ai", "claude-code"), { recursive: true });
    const cli = join(dir, "@anthropic-ai", "claude-code", "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    const run = (arg: string) => spawn(process.execPath, [cli, arg], { stdio: "ignore" });
    const real = run("--dangerously-skip-permissions");
    const prompt = run(" --dangerously-skip-permissions");
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (psProcessReader(real.pid!) === null || psProcessReader(prompt.pid!) === null)) execFileSync("sleep", ["0.05"]);
      expect(psProcessReader(real.pid!)?.command).toBe(`${process.execPath} ${cli} --dangerously-skip-permissions`);
      expect(psProcessReader(prompt.pid!)?.command).toBe(`${process.execPath} ${cli}  --dangerously-skip-permissions`);
      expect(detectPenPermissionModeWith(psProcessReader, real.pid!)).toBe("bypassPermissions");
      expect(detectPenPermissionModeWith(psProcessReader, prompt.pid!)).toBeNull();
    } finally {
      real.kill(); prompt.kill();
    }
  });

  it("the ps parser accepts exactly one line and the reader treats a missing process or a throw as unknown", () => {
    expect(parsePsLine("  90 claude --dangerously-skip-permissions\n")).toEqual({ ppid: 90, command: "claude --dangerously-skip-permissions" });
    expect(parsePsLine("90 -zsh")).toEqual({ ppid: 90, command: "-zsh" });
    expect(parsePsLine("  90 claude --system-prompt hello --dangerously-skip-permissions\nmore text\n")).toBeNull();
    expect(parsePsLine("garbage")).toBeNull();
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("\n\n")).toBeNull();
    // the real reader on this process parses, and on a pid that cannot exist returns null (ps exits non-zero)
    const self = psProcessReader(process.pid);
    expect(self).not.toBeNull();
    expect(self!.ppid).toBe(process.ppid);
    expect(psProcessReader(2147483647)).toBeNull();
    // a multi-line command line reaching the walk is unknown, never bypass
    const multi: ProcessReader = () => parsePsLine("  90 claude --dangerously-skip-permissions\nmore\n");
    expect(detectPenPermissionModeWith(multi, 100)).toBeNull();
  });

  it("the walk stops at the nearest claude ancestor and treats an unreadable or missing chain as unknown", () => {
    const tree = (rows: Record<number, { ppid: number; command: string }>): ProcessReader => (pid) => rows[pid] ?? null;
    // observed macOS chain: storybloq <- zsh -c <- claude <- -zsh <- login <- Terminal
    const mac = tree({
      100: { ppid: 90, command: "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snap.sh 2>/dev/null || true" },
      90: { ppid: 80, command: "claude --dangerously-skip-permissions" },
      80: { ppid: 70, command: "-zsh" },
      70: { ppid: 1, command: "login -pfl me /bin/bash -c exec -la zsh /bin/zsh" },
    });
    expect(detectPenPermissionModeWith(mac, 100)).toBe("bypassPermissions");
    // a prompting inner pen beneath a bypass outer session: the inner one decides
    const nested = tree({
      100: { ppid: 90, command: "/bin/sh -c storybloq duet spawn" },
      90: { ppid: 80, command: "claude --permission-mode acceptEdits --verbose" },
      80: { ppid: 70, command: "/bin/zsh" },
      70: { ppid: 1, command: "claude --dangerously-skip-permissions" },
    });
    expect(detectPenPermissionModeWith(nested, 100)).toBe("acceptEdits");
    // a nearest pen whose line carries an unknown token is unknown, and the outer bypass pen is never consulted
    const nestedUnknown = tree({ 100: { ppid: 90, command: "sh" }, 90: { ppid: 80, command: "claude -n inner" }, 80: { ppid: 1, command: "claude --dangerously-skip-permissions" } });
    expect(detectPenPermissionModeWith(nestedUnknown, 100)).toBeNull();
    // an ambiguous nearest pen is unknown even when an outer pen is bypass
    const ambiguous = tree({ 100: { ppid: 90, command: "claude do it --dangerously-skip-permissions" }, 90: { ppid: 1, command: "claude --dangerously-skip-permissions" } });
    expect(detectPenPermissionModeWith(ambiguous, 100)).toBeNull();
    // linux ps shape (same columns) and a node entry
    const linux = tree({ 100: { ppid: 90, command: "bash -c storybloq" }, 90: { ppid: 1, command: "node /home/me/.npm/_npx/abc/node_modules/@anthropic-ai/claude-code/cli.js --permission-mode bypassPermissions" } });
    expect(detectPenPermissionModeWith(linux, 100)).toBe("bypassPermissions");
    // no claude anywhere, an unreadable process, and a chain that ends at init
    expect(detectPenPermissionModeWith(tree({ 100: { ppid: 1, command: "-zsh" } }), 100)).toBeNull();
    expect(detectPenPermissionModeWith(tree({}), 100)).toBeNull();
    expect(detectPenPermissionModeWith(tree({ 100: { ppid: 99, command: "sh" }, 99: { ppid: 0, command: "launchd" } }), 100)).toBeNull();
    expect(resolvePermissionMode(undefined, () => detectPenPermissionModeWith(ambiguous, 100)).mode).toBe("auto");
  });
});

/**
 * A stub `claude` that records its working directory, the two project-root
 * variables it saw (lines 1 and 2), and its argv (from line 3). `run` executes
 * the launch script, `paste` the pasted command through sh; `inherit` is what
 * the environment starting the launch already carries.
 */
function stubClaude(dir: string): {
  run: (script: string, inherit?: Record<string, string>) => string[];
  paste: (command: string, inherit?: Record<string, string>) => string[];
} {
  const bin = join(dir, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "stub.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\npwd > '${log}'\nprintf 'root=%s\\n' "$STORYBLOQ_PROJECT_ROOT" >> '${log}'\nprintf 'legacy=%s\\n' "$CLAUDESTORY_PROJECT_ROOT" >> '${log}'\nprintf '%s\\n' "$@" >> '${log}'\n`);
  execFileSync("chmod", ["755", join(bin, "claude")]);
  const env = (inherit: Record<string, string>): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete e.STORYBLOQ_PROJECT_ROOT;
    delete e.CLAUDESTORY_PROJECT_ROOT;
    return { ...e, ...inherit };
  };
  const read = () => readFileSync(log, "utf-8").trim().split("\n");
  return {
    run: (script, inherit = {}) => { execFileSync(script, { env: env(inherit) }); return read(); },
    paste: (command, inherit = {}) => { execFileSync("/bin/sh", ["-c", command], { env: env(inherit) }); return read(); },
  };
}

/** What a shell profile, or a pen itself launched against a board, may already export. */
const DECOY = { STORYBLOQ_PROJECT_ROOT: "/decoy/board", CLAUDESTORY_PROJECT_ROOT: "/decoy/legacy" };

describe("ISS-1303: the worker's model is pinned, never inherited", () => {
  it("absent or empty --model resolves to the hands tier with its reason; an explicit model passes through with its own", () => {
    expect(DEFAULT_WORKER_MODEL).toBe("opus");
    expect(resolveWorkerModel(undefined)).toEqual({ model: "opus", source: "default" });
    expect(resolveWorkerModel("")).toEqual({ model: "opus", source: "default" });
    expect(resolveWorkerModel("sonnet")).toEqual({ model: "sonnet", source: "explicit" });
    expect(workerModelReason("default")).toBe("default hands tier; pass --model to pin another");
    expect(workerModelReason("explicit")).toBe("as given on the command line");
  });

  it("a spawn without --model launches with --model opus and reports why; --model sonnet reaches the argv as given", () => {
    const root = project();
    const p = prep(root, "w");
    const r = spawnWorker(root, { name: "w", pen: "p", ...p }, () => null, noPen);
    expect(readFileSync(r.scriptPath, "utf-8")).toContain(`--session-id '${p.workerTaskId}' --model 'opus' --permission-mode`);
    expect(r.command).toContain(" --model 'opus' ");
    expect(r.model).toBe("opus");
    expect(r.modelSource).toBe("default");
    expect(r.modelReason).toBe("default hands tier; pass --model to pin another");
    const q = prep(root, "w2");
    const s = spawnWorker(root, { name: "w2", pen: "p", model: "sonnet", ...q }, () => null, noPen);
    const argv = stubClaude(root).run(s.scriptPath);
    expect(argv.slice(3, 8)).toEqual(["-n", "w2", "--session-id", q.workerTaskId, "--model"]);
    expect(argv[8]).toBe("sonnet");
    expect(argv.filter((a) => a === "--model")).toHaveLength(1);
    expect(s.modelSource).toBe("explicit");
    expect(s.modelReason).toBe("as given on the command line");
  });
});

describe("ISS-1305: a working directory with no ledger works against the pen's board", () => {
  async function penAndBare() {
    const pen = mkdtempSync(join(tmpdir(), "duet-pen-"));
    await initProject(pen, { name: "pen" });
    const bare = mkdtempSync(join(tmpdir(), "duet-worktree-"));
    return { pen, bare };
  }

  it("resolves a directory with no .story to the third case, and the role names the board and the working directory", async () => {
    const { pen, bare } = await penAndBare();
    expect(resolveWorkerDir(pen, bare)).toEqual({ workerDir: bare, workerProjectRoot: null });
    const para = ledgerParagraph({ workerDir: bare, penProjectRoot: pen, workerProjectRoot: null, workerTaskId: mintWorkerTaskId() });
    expect(para).toContain(`Your \`/story\` loads the board at ${realpathSync(pen)}`);
    expect(para).toContain(`your working directory is \`${bare}\`, which carries no ledger`);
    expect(para).toContain("never run the setup flow");
    expect(para).not.toContain("will offer setup");
    const p = prep(pen, "w", bare);
    const r = spawnWorker(pen, { name: "w", pen: "p", dir: bare, handshake: HANDSHAKE, ...p }, () => null, noPen);
    const role = readFileSync(r.rolePath, "utf-8");
    expect(role).toContain(`loads the board at ${realpathSync(pen)}`);
    expect(role).toContain(`\`${bare}\`, which carries no ledger`);
  });

  it("the launch cds into the worktree and points /story at the pen's board through STORYBLOQ_PROJECT_ROOT, in the script and the pasted command", async () => {
    const { pen, bare } = await penAndBare();
    const p = prep(pen, "w", bare);
    const r = spawnWorker(pen, { name: "w", pen: "p", dir: bare, ...p }, () => null, noPen);
    const script = readFileSync(r.scriptPath, "utf-8");
    expect(script).toContain(`cd '${bare}' || exit 1\nexport STORYBLOQ_PROJECT_ROOT='${realpathSync(pen)}'\nexec claude -n 'w'`);
    expect(r.command.startsWith(`cd '${bare}' && STORYBLOQ_PROJECT_ROOT='${realpathSync(pen)}' claude -n 'w' `)).toBe(true);
    const stub = stubClaude(pen);
    const seen = stub.run(r.scriptPath);
    expect(realpathSync(seen[0]!)).toBe(realpathSync(bare));
    expect(seen[1]).toBe(`root=${realpathSync(pen)}`);
    // An inherited override never wins over the board: the launch assigns its
    // own, which discovery reads before the legacy name.
    expect(stub.run(r.scriptPath, DECOY)[1]).toBe(`root=${realpathSync(pen)}`);
    const pasted = stub.paste(r.command, DECOY);
    expect(realpathSync(pasted[0]!)).toBe(realpathSync(bare));
    expect(pasted[1]).toBe(`root=${realpathSync(pen)}`);
  });

  it("the same-project and other-project launches clear both project-root variables, in the script and the pasted command, even when the launching environment carries them", async () => {
    const { pen } = await penAndBare();
    const other = mkdtempSync(join(tmpdir(), "duet-node-"));
    await initProject(other, { name: "node" });
    mkdirSync(join(pen, "sub"));
    for (const [name, dir] of [["ws", join(pen, "sub")], ["wo", other]] as const) {
      const p = prep(pen, name, dir);
      const r = spawnWorker(pen, { name, pen: "p", dir, ...p }, () => null, noPen);
      const script = readFileSync(r.scriptPath, "utf-8");
      expect(script).toContain(`cd '${dir}' || exit 1\nunset STORYBLOQ_PROJECT_ROOT CLAUDESTORY_PROJECT_ROOT\nexec claude -n '${name}'`);
      expect(script).not.toContain("export STORYBLOQ_PROJECT_ROOT");
      expect(r.command.startsWith(`cd '${dir}' && env -u STORYBLOQ_PROJECT_ROOT -u CLAUDESTORY_PROJECT_ROOT claude -n '${name}' `)).toBe(true);
      const stub = stubClaude(pen);
      expect(stub.run(r.scriptPath, DECOY).slice(1, 3), name).toEqual(["root=", "legacy="]);
      const pasted = stub.paste(r.command, DECOY);
      expect(realpathSync(pasted[0]!), name).toBe(realpathSync(dir));
      expect(pasted.slice(1, 3), name).toEqual(["root=", "legacy="]);
    }
  });

  it("classifies the working directory by what the worker will find there, never by this process's project-root variables", async () => {
    const { pen, bare } = await penAndBare();
    const other = mkdtempSync(join(tmpdir(), "duet-node-"));
    await initProject(other, { name: "node" });
    mkdirSync(join(pen, "sub"));
    // The realistic case: the pen itself runs against its board through the
    // override, and a stale legacy value sits beside it.
    const cases = [{ STORYBLOQ_PROJECT_ROOT: pen }, { CLAUDESTORY_PROJECT_ROOT: other }, { STORYBLOQ_PROJECT_ROOT: other, CLAUDESTORY_PROJECT_ROOT: pen }];
    for (const [i, inherited] of cases.entries()) {
      const saved = { s: process.env.STORYBLOQ_PROJECT_ROOT, c: process.env.CLAUDESTORY_PROJECT_ROOT };
      Object.assign(process.env, inherited);
      try {
        const label = JSON.stringify(inherited);
        expect(resolveWorkerDir(pen, bare), label).toEqual({ workerDir: bare, workerProjectRoot: null });
        expect(resolveWorkerDir(pen, other), label).toEqual({ workerDir: other, workerProjectRoot: realpathSync(other) });
        expect(resolveWorkerDir(pen, join(pen, "sub")), label).toEqual({ workerDir: join(pen, "sub"), workerProjectRoot: realpathSync(pen) });
        // and so the no-ledger launch still points the worker at the board
        const p = prep(pen, `wb${i}`, bare);
        expect(p.workerProjectRoot, label).toBeNull();
        const r = spawnWorker(pen, { name: `wb${i}`, pen: "p", dir: bare, ...p }, () => null, noPen);
        expect(readFileSync(r.scriptPath, "utf-8"), label).toContain(`export STORYBLOQ_PROJECT_ROOT='${realpathSync(pen)}'`);
      } finally {
        for (const [k, v] of [["STORYBLOQ_PROJECT_ROOT", saved.s], ["CLAUDESTORY_PROJECT_ROOT", saved.c]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    }
  });

  it("refuses only when the pen's own project cannot be resolved", () => {
    const noProject = mkdtempSync(join(tmpdir(), "duet-nopen-"));
    const bare = mkdtempSync(join(tmpdir(), "duet-worktree-"));
    expect(() => resolveWorkerDir(noProject, bare)).toThrow(/the pen's project cannot be resolved/);
    expect(() => resolveWorkerDir(noProject)).toThrow(/the pen's project cannot be resolved/);
    // a .story directory without config.json is not a project either
    mkdirSync(join(noProject, ".story"));
    expect(() => resolveWorkerDir(noProject, bare)).toThrow(/the pen's project cannot be resolved/);
  });
});
