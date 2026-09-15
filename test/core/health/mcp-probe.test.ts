/**
 * T-509 part 3: the real `probeMcpServer` adapter against fixture servers.
 *
 * Every case asserts the returned kind AND that no child survives the call:
 * the adapter owns the process tree it starts, and a leaked server is the
 * failure these tests exist to catch. Each launch carries a unique token as
 * a trailing argv entry so the survivor scan sees only this test's processes.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSync, type spawn as spawnFn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROBE_MIN_MS, probeMcpServer } from "../../../src/core/health/deps.js";
import type { McpLaunch } from "../../../src/core/health/types.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));

let seq = 0;
function token(): string {
  seq += 1;
  return `sb-probe-${process.pid}-${Date.now()}-${seq}`;
}

function launchFor(name: string, tok: string, envOverrides: Record<string, string> = {}): McpLaunch {
  return { argv: [process.execPath, fixture(name), tok], envOverrides };
}

/** Processes whose command line carries this launch's token. */
function survivors(tok: string): string[] {
  const out = spawnSync("pgrep", ["-fl", tok], { encoding: "utf-8" }).stdout ?? "";
  // pgrep -f also matches itself on some platforms; drop the pgrep line.
  return out.split("\n").filter((l) => l.trim().length > 0 && !l.includes("pgrep"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (pred()) return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return pred();
}

const far = () => Date.now() + 60_000;

/** Every launch's process tree must be gone once the adapter resolves; bounded polling absorbs reaping lag. */
async function expectReaped(tok: string): Promise<void> {
  expect(await until(() => survivors(tok).length === 0)).toBe(true);
}

/** Launch a fixture, and ALWAYS assert its tree was reaped before handing back the result. */
async function probe(name: string, capMs = 5_000, deadlineAt = far(), env: Record<string, string> = {}) {
  const tok = token();
  const r = await probeMcpServer(launchFor(name, tok, env), deadlineAt, capMs, { env: process.env });
  await expectReaped(tok);
  return { r, tok };
}

describe("T-509 probeMcpServer", () => {
  it("answers ok for a healthy persistent server and tears it down", async () => {
    const { r, tok } = await probe("mcp-healthy");
    expect(r).toMatchObject({ kind: "ok", serverName: "fixture-bridge", serverVersion: "9.9.9", protocolVersion: "2024-11-05", allocatedMs: 5000 });
    await expectReaped(tok);
  });

  it("reassembles a response written in three fragments", async () => {
    const { r, tok } = await probe("mcp-fragmented");
    expect(r.kind).toBe("ok");
    await expectReaped(tok);
  });

  it("ignores non-JSON lines before and around the answer", async () => {
    expect((await probe("mcp-noisy")).r.kind).toBe("ok");
  });

  it("ignores notifications and other ids and still accepts the id 1 result", async () => {
    expect((await probe("mcp-unrelated")).r.kind).toBe("ok");
  });

  it("reports a JSON-RPC error as failed with the protocol error", async () => {
    const { r, tok } = await probe("mcp-error");
    expect(r).toMatchObject({ kind: "failed", reason: "protocol error: unsupported client" });
    await expectReaped(tok);
  });

  it("reports a result missing protocolVersion, capabilities or serverInfo.version as malformed", async () => {
    expect((await probe("mcp-malformed")).r).toMatchObject({ kind: "failed", reason: "malformed initialize result (protocolVersion)" });
    expect((await probe("mcp-missing-caps")).r).toMatchObject({ kind: "failed", reason: "malformed initialize result (capabilities)" });
    expect((await probe("mcp-missing-version")).r).toMatchObject({ kind: "failed", reason: "malformed initialize result (serverInfo.version)" });
    const last = await probe("mcp-invalid");
    expect(last.r).toMatchObject({ kind: "failed", reason: "malformed initialize result (result)" });
    await expectReaped(last.tok);
  });

  it("reports an unsupported protocol version by name", async () => {
    expect((await probe("mcp-unsupported")).r).toMatchObject({ kind: "failed", reason: "unsupported protocol version 1999-01-01" });
  });

  it("reports an exit before the answer as failed with the code and the stderr tail", async () => {
    const { r } = await probe("mcp-bindings-exit");
    expect(r).toMatchObject({ kind: "failed", code: 1, signal: null });
    expect((r as { stderr: string }).stderr).toContain("Could not locate the bindings file");
  });

  it("reports a hang as timeout with the allocation, and the server is gone afterwards", async () => {
    const { r, tok } = await probe("mcp-hang", 800);
    expect(r).toEqual({ kind: "timeout", allocatedMs: 800 });
    await expectReaped(tok);
  });

  it("caps the allocation at the remaining budget", async () => {
    const { r } = await probe("mcp-hang", 5_000, Date.now() + 700);
    expect(r.kind).toBe("timeout");
    expect((r as { allocatedMs: number }).allocatedMs).toBeLessThanOrEqual(700);
    expect((r as { allocatedMs: number }).allocatedMs).toBeGreaterThanOrEqual(BRIDGE_PROBE_MIN_MS);
  });

  it("is not attempted when the remaining budget is under the floor, and spawns nothing", async () => {
    const tok = token();
    const spawned: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      spawned.push(cmd);
      throw new Error("must not spawn");
    }) as unknown as typeof spawnFn;
    const r = await probeMcpServer(launchFor("mcp-healthy", tok), Date.now() + BRIDGE_PROBE_MIN_MS - 50, 5_000, { env: process.env, spawn: fakeSpawn });
    expect(r).toEqual({ kind: "not-attempted", reason: "budget exhausted" });
    expect(spawned).toEqual([]);
  });

  it("second of two probes under one near-exhausted deadline is not attempted", async () => {
    const deadline = Date.now() + 500;
    const first = await probe("mcp-hang", 5_000, deadline);
    expect(first.r.kind).toBe("timeout");
    const second = await probe("mcp-healthy", 5_000, deadline);
    expect(second.r).toEqual({ kind: "not-attempted", reason: "budget exhausted" });
  });

  it("reaps the exact grandchild a launcher spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-grandchild-"));
    const pidFile = join(dir, "pid");
    try {
      const { r, tok } = await probe("mcp-grandchild", 5_000, far(), { SB_GRANDCHILD_PID_FILE: pidFile });
      expect(r.kind).toBe("ok");
      const pid = Number(readFileSync(pidFile, "utf-8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(await until(() => !alive(pid))).toBe(true);
      await expectReaped(tok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a grandchild that ignores SIGTERM even though its launcher exited on it", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "sb-orphan-"));
    const pidFile = join(dir, "pid");
    try {
      const { r, tok } = await probe("mcp-grandchild", 5_000, far(), { SB_GRANDCHILD_PID_FILE: pidFile, SB_IGNORE_SIGTERM: "1" });
      expect(r.kind).toBe("ok");
      const pid = Number(readFileSync(pidFile, "utf-8"));
      expect(pid > 0).toBe(true);
      expect(await until(() => !alive(pid))).toBe(true);
      await expectReaped(tok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a live server that exceeds the output limit, and kills it", async () => {
    const { r, tok } = await probe("mcp-output-limit");
    expect(r).toMatchObject({ kind: "failed", reason: "output limit" });
    await expectReaped(tok);
  });

  it("survives a server that closes stdin (EPIPE on the initialize write) and still reports the outcome", async () => {
    // Deterministic through the spawn seam: the fake child's stdin errors
    // with EPIPE on the first write, exactly as a closed pipe does.
    let errored = 0;
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; signalCode: string | null; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.pid = undefined;
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.write = ((): boolean => {
        errored += 1;
        const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        process.nextTick(() => child.stdin.emit("error", err));
        return false;
      }) as typeof child.stdin.write;
      return child;
    }) as unknown as typeof spawnFn;
    const r = await probeMcpServer({ argv: ["fake"], envOverrides: {} }, far(), 300, { env: process.env, spawn: fakeSpawn });
    expect(errored).toBe(1);
    expect(r).toEqual({ kind: "timeout", allocatedMs: 300 });
  });

  it("also survives the real fixture that destroys its stdin, and kills it", async () => {
    const { r, tok } = await probe("mcp-close-stdin", 600);
    expect(r.kind).toBe("timeout");
    await expectReaped(tok);
  });

  it("reports a missing executable as enoent", async () => {
    const e = await probeMcpServer({ argv: ["/definitely/not/here"], envOverrides: {} }, far(), 5_000, { env: process.env });
    expect(e).toMatchObject({ kind: "enoent" });
  });

  it("reports a non-executable file as failed with the errno, not enoent", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "sb-noexec-"));
    try {
      const file = join(dir, "bridge");
      writeFileSync(file, "#!/bin/sh\necho hi\n");
      chmodSync(file, 0o644);
      const r = await probeMcpServer({ argv: [file], envOverrides: {} }, far(), 5_000, { env: process.env });
      expect(r).toMatchObject({ kind: "failed", reason: "EACCES" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges envOverrides over the inherited environment", async () => {
    // A fixture-free check: `node -e` echoes the variable as a valid answer.
    const script = `process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2024-11-05",capabilities:{},serverInfo:{name:process.env.SB_PROBE_NAME,version:"1"}}})+"\\n");setInterval(()=>{},1000)`;
    const tok = token();
    const r = await probeMcpServer({ argv: [process.execPath, "-e", script, tok], envOverrides: { SB_PROBE_NAME: "from-override" } }, far(), 5_000, { env: { ...process.env, SB_PROBE_NAME: "inherited" } });
    expect(r).toMatchObject({ kind: "ok", serverName: "from-override" });
    await expectReaped(tok);
  });
});
