import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { spawnWorker, buildWorkerCommand, shellQuote, defaultWorkerRole, validateWorkerName, resolvePermissionMode, detectPenPermissionMode, detectPenPermissionModeWith, classifyClaudeCommand, psProcessReader, parsePsLine, type Launcher, type ProcessReader } from "../../src/core/duet-spawn.js";
import { handleDuetSpawn } from "../../src/cli/commands/duet-spawn.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "duet-spawn-"));
  mkdirSync(join(root, ".story"), { recursive: true });
  return root;
}

const noPen = () => null;

describe("N-131: storybloq duet spawn", () => {
  it("writes an executable launch script, a role naming the pen, and a record; the injected launcher receives the script", () => {
    const root = project();
    const calls: Array<[string, string | undefined]> = [];
    const launcher: Launcher = (script, terminal) => { calls.push([script, terminal]); return "fake-open"; };
    const r = spawnWorker(root, { name: "cpm-w2", pen: "cpm-00", model: "opus" }, launcher, noPen);
    expect(r.launch).toBe("opened");
    expect(r.launcher).toBe("fake-open");
    expect(calls).toEqual([[r.scriptPath, undefined]]);
    expect(dirname(dirname(r.scriptPath))).toBe(join(root, ".story", "sessions", "spawn"));
    expect(basename(dirname(r.scriptPath))).toMatch(/^cpm-w2\..+$/);
    expect(basename(r.scriptPath)).toBe("cpm-w2.command");
    expect(statSync(r.scriptPath).mode & 0o111).not.toBe(0);
    const script = readFileSync(r.scriptPath, "utf-8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`cd '${root}' || exit 1`);
    expect(script).toContain(`exec claude -n 'cpm-w2' --model 'opus' --permission-mode 'auto' --append-system-prompt-file '${r.rolePath}'`);
    const role = readFileSync(r.rolePath, "utf-8");
    expect(role).toContain("named `cpm-00`");
    expect(role).toContain("Do not start work on your own");
    expect(role).toContain("turn ending, continue needed");
    const record = JSON.parse(readFileSync(r.recordPath, "utf-8"));
    expect(record).toMatchObject({ name: "cpm-w2", pen: "cpm-00", model: "opus", dir: root, permissionMode: "auto", permissionModeSource: "default" });
    expect(r.command).toBe(`cd '${root}' && claude -n 'cpm-w2' --model 'opus' --permission-mode 'auto' --append-system-prompt-file '${r.rolePath}'`);
  });

  it("the script actually runs: with a stub `claude` on PATH it cds into the dir and passes the exact arguments", () => {
    const root = project();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "claude.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\npwd > '${log}'\nprintf '%s\\n' "$@" >> '${log}'\n`);
    execFileSync("chmod", ["755", join(bin, "claude")]);
    const r = spawnWorker(root, { name: "w1", pen: "p1", print: true }, undefined, noPen);
    execFileSync(r.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(realpathSync(lines[0]!)).toBe(realpathSync(root));
    expect(lines.slice(1)).toEqual(["-n", "w1", "--permission-mode", "auto", "--append-system-prompt-file", r.rolePath]);
  });

  it("--print writes everything and launches nothing; a launcher that has no handler reports printed", () => {
    const root = project();
    let called = 0;
    const printed = spawnWorker(root, { name: "w", pen: "p", print: true }, () => { called++; return "x"; });
    expect(called).toBe(0);
    expect(printed.launch).toBe("printed");
    expect(existsSync(printed.scriptPath)).toBe(true);
    const none = spawnWorker(root, { name: "w2", pen: "p" }, () => null);
    expect(none.launch).toBe("printed");
    expect(none.launcher).toBeNull();
  });

  it("a custom role file is used as given and must exist; --terminal and --dir reach the script and the launcher", () => {
    const root = project();
    const role = join(root, "role.md");
    writeFileSync(role, "custom role");
    const seen: Array<string | undefined> = [];
    const r = spawnWorker(root, { name: "w", pen: "p", role: "role.md", dir: "sub", terminal: "Ghostty" }, (_s, t) => { seen.push(t); return "open -a"; });
    expect(r.rolePath).toBe(role);
    expect(readFileSync(r.scriptPath, "utf-8")).toContain(`cd '${join(root, "sub")}' || exit 1`);
    expect(seen).toEqual(["Ghostty"]);
    expect(() => spawnWorker(root, { name: "w3", pen: "p", role: "missing.md", print: true })).toThrow(/ENOENT/);
  });

  it("names are validated and the worker may not be the pen; shell quoting survives a quote", () => {
    const root = project();
    expect(() => spawnWorker(root, { name: "bad name", pen: "p", print: true })).toThrow(/Invalid worker name/);
    expect(() => spawnWorker(root, { name: "../x", pen: "p", print: true })).toThrow(/Invalid worker name/);
    expect(() => spawnWorker(root, { name: "same", pen: "same", print: true })).toThrow(/must differ/);
    expect(() => validateWorkerName("ok-1.a_b")).not.toThrow();
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildWorkerCommand({ name: "n", rolePath: "/r x.md" })).toBe(`claude -n 'n' --append-system-prompt-file '/r x.md'`);
    expect(buildWorkerCommand({ name: "n", model: "", rolePath: "/r" })).not.toContain("--model");
    expect(defaultWorkerRole("pen", "w")).toContain("# Duet worker w");
  });

  it("the CLI handler renders md and a versioned json envelope", () => {
    const root = project();
    const md = handleDuetSpawn({ name: "w", pen: "p", print: true }, "md", root);
    expect(md.exitCode).toBe(0);
    expect(md.output).toContain('Worker "w" is ready to start');
    expect(md.output).toContain("claude -n 'w'");
    expect(md.output).toContain("handshake by name from the pen (p)");
    const json = JSON.parse(handleDuetSpawn({ name: "w2", pen: "p", print: true }, "json", root).output);
    expect(json.version).toBe(1);
    expect(json.data.launch).toBe("printed");
    expect(json.data.name).toBe("w2");
  });

  // Probe loop, bug category: environment mismatch. A real spawn came up in
  // "prompting" mode beside a bypass pen; the mode must be an explicit,
  // validated passthrough that reaches the claude argv.
  it("--permission-mode reaches the argv exactly and is validated; absent means auto unless the pen is in bypass", () => {
    const root = project();
    const r = spawnWorker(root, { name: "w", pen: "p", permissionMode: "bypassPermissions", print: true });
    expect(readFileSync(r.scriptPath, "utf-8")).toContain(`--permission-mode 'bypassPermissions' --append-system-prompt-file`);
    expect(JSON.parse(readFileSync(r.recordPath, "utf-8")).permissionMode).toBe("bypassPermissions");
    const bin = join(root, "bin"); mkdirSync(bin);
    const log = join(root, "argv.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    execFileSync("chmod", ["755", join(bin, "claude")]);
    execFileSync(r.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual(["-n", "w", "--permission-mode", "bypassPermissions", "--append-system-prompt-file", r.rolePath]);
    expect(() => spawnWorker(root, { name: "w2", pen: "p", permissionMode: "yolo", print: true })).toThrow(/Unknown permission mode/);
    const plain = spawnWorker(root, { name: "w3", pen: "p", print: true }, undefined, noPen);
    expect(readFileSync(plain.scriptPath, "utf-8")).toContain("--permission-mode 'auto'");
    expect(plain.permissionModeSource).toBe("default");
  });

  // Review finding (Codex, 2026-09-22), category: race. A second spawn with the
  // same name used to overwrite the script, role and record of the first while
  // `open` might not have read them yet. Every invocation now owns its files.
  it("two spawns with the same name never share or overwrite an artifact", () => {
    const root = project();
    const a = spawnWorker(root, { name: "w", pen: "p", model: "sonnet", print: true }, undefined, noPen);
    const b = spawnWorker(root, { name: "w", pen: "p", model: "opus", dir: "elsewhere", print: true }, undefined, noPen);
    expect(a.scriptPath).not.toBe(b.scriptPath);
    expect(a.rolePath).not.toBe(b.rolePath);
    expect(a.recordPath).not.toBe(b.recordPath);
    expect(readFileSync(a.scriptPath, "utf-8")).toContain("--model 'sonnet'");
    expect(readFileSync(a.scriptPath, "utf-8")).toContain(`cd '${root}'`);
    expect(readFileSync(b.scriptPath, "utf-8")).toContain("--model 'opus'");
    expect(JSON.parse(readFileSync(a.recordPath, "utf-8")).model).toBe("sonnet");
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
    const r = spawnWorker(root, { name: "w", pen: "p", print: true }, undefined, () => "bypassPermissions");
    expect(readFileSync(r.scriptPath, "utf-8")).toContain("--permission-mode 'bypassPermissions'");
    expect(JSON.parse(readFileSync(r.recordPath, "utf-8")).permissionModeSource).toBe("inherited-bypass");
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
