import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { spawnWorker, buildWorkerCommand, shellQuote, defaultWorkerRole, validateWorkerName, type Launcher } from "../../src/core/duet-spawn.js";
import { handleDuetSpawn } from "../../src/cli/commands/duet-spawn.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "duet-spawn-"));
  mkdirSync(join(root, ".story"), { recursive: true });
  return root;
}

describe("N-131: storybloq duet spawn", () => {
  it("writes an executable launch script, a role naming the pen, and a record; the injected launcher receives the script", () => {
    const root = project();
    const calls: Array<[string, string | undefined]> = [];
    const launcher: Launcher = (script, terminal) => { calls.push([script, terminal]); return "fake-open"; };
    const r = spawnWorker(root, { name: "cpm-w2", pen: "cpm-00", model: "opus" }, launcher);
    expect(r.launch).toBe("opened");
    expect(r.launcher).toBe("fake-open");
    expect(calls).toEqual([[r.scriptPath, undefined]]);
    expect(r.scriptPath).toBe(join(root, ".story", "sessions", "spawn", "cpm-w2.command"));
    expect(statSync(r.scriptPath).mode & 0o111).not.toBe(0);
    const script = readFileSync(r.scriptPath, "utf-8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`cd '${root}' || exit 1`);
    expect(script).toContain(`exec claude -n 'cpm-w2' --model 'opus' --append-system-prompt-file '${r.rolePath}'`);
    const role = readFileSync(r.rolePath, "utf-8");
    expect(role).toContain("named `cpm-00`");
    expect(role).toContain("Do not start work on your own");
    expect(role).toContain("turn ending, continue needed");
    const record = JSON.parse(readFileSync(r.recordPath, "utf-8"));
    expect(record).toMatchObject({ name: "cpm-w2", pen: "cpm-00", model: "opus", dir: root });
    expect(r.command).toBe(`cd '${root}' && claude -n 'cpm-w2' --model 'opus' --append-system-prompt-file '${r.rolePath}'`);
  });

  it("the script actually runs: with a stub `claude` on PATH it cds into the dir and passes the exact arguments", () => {
    const root = project();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "claude.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\npwd > '${log}'\nprintf '%s\\n' "$@" >> '${log}'\n`);
    execFileSync("chmod", ["755", join(bin, "claude")]);
    const r = spawnWorker(root, { name: "w1", pen: "p1", print: true });
    execFileSync(r.scriptPath, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(realpathSync(lines[0]!)).toBe(realpathSync(root));
    expect(lines.slice(1)).toEqual(["-n", "w1", "--append-system-prompt-file", r.rolePath]);
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
});
