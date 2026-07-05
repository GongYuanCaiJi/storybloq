import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { handleReserve } from "../../../src/cli/commands/reserve.js";
import { registerTeamCommand } from "../../../src/cli/register.js";
import { initProject } from "../../../src/core/init.js";
import { ExitCode } from "../../../src/core/output-formatter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ISS-805: handleReserve invalid --count json envelope", () => {
  it("count above max (101) with format json is parseable with ok:false and USER_ERROR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reserve-test-"));
    dirs.push(dir);
    await initProject(dir, { name: "reserve-test" });
    const result = await handleReserve(dir, "tickets", 101, "json");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  it("non-integer count with format json is parseable with ok:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reserve-test-"));
    dirs.push(dir);
    await initProject(dir, { name: "reserve-test" });
    const result = await handleReserve(dir, "issues", 2.5, "json");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
  });

  it("count 0 with format md keeps the plain-text shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reserve-test-"));
    dirs.push(dir);
    await initProject(dir, { name: "reserve-test" });
    const result = await handleReserve(dir, "notes", 0, "md");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("--count");
  });
});

async function runTeamReserveCli(
  args: string[],
): Promise<{ out: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await registerTeamCommand(yargs(args)).exitProcess(false).parseAsync();
  } catch {
    // yargs validation may throw with exitProcess(false); assert on captured output.
  } finally {
    spy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExit;
  return { out: chunks.join(""), exitCode };
}

describe("ISS-805: team reserve wrapper json envelopes (R2/R3)", () => {
  it("R2: invalid --count is rejected with a json envelope before project discovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reserve-noproj-"));
    dirs.push(dir);
    const prevCwd = process.cwd();
    process.chdir(dir); // no .story here: proves the count envelope wins outside a project
    try {
      const { out, exitCode } = await runTeamReserveCli([
        "team",
        "reserve",
        "tickets",
        "--count",
        "101",
        "--format",
        "json",
      ]);
      const parsed = JSON.parse(out.trim());
      expect(parsed.ok).toBe(false);
      expect(exitCode).toBe(ExitCode.USER_ERROR);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("R3: a post-validation handler failure (malformed config) yields one parseable json object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reserve-badcfg-"));
    dirs.push(dir);
    await mkdir(join(dir, ".story"), { recursive: true });
    await writeFile(join(dir, ".story", "config.json"), "{ this is not valid json");
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const { out } = await runTeamReserveCli([
        "team",
        "reserve",
        "tickets",
        "--count",
        "1",
        "--format",
        "json",
      ]);
      const parsed = JSON.parse(out.trim());
      expect(parsed.ok).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
