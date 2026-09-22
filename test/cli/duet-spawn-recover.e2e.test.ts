import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

/**
 * T-530: `storybloq duet spawn --recover` is a read-only listing that must parse
 * WITHOUT the launch options. The registration used to `demandOption` --name and
 * --pen, which yargs enforces before any handler runs, so the documented recovery
 * invocation was rejected at the parser. The rule now lives in a `.check()` that
 * excuses --recover and nothing else.
 */
let fixture: E2ECliFixture;
beforeAll(async () => { fixture = await E2ECliFixture.create(); });
afterAll(async () => { await fixture.cleanup(); });

function run(cwd: string, ...args: string[]): { code: number; out: string; stdout: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { code: result.status ?? 1, out: `${result.stdout}\n${result.stderr}`, stdout: result.stdout };
}

describe("duet spawn parser (T-530)", () => {
  it("--recover parses with no --name, --pen or --bounds and lists nothing on a fresh project", () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-recover-e2e-"));
    expect(run(dir, "init", "--name", "r").code).toBe(0);
    const res = run(dir, "duet", "spawn", "--recover");
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain("No spawn journals");
    const json = run(dir, "duet", "spawn", "--recover", "--format", "json");
    expect(json.code, json.out).toBe(0);
    expect(JSON.parse(json.stdout).data.candidates).toEqual([]);
  });

  it("--name without --pen is still refused at the parser, before any handler runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-recover-e2e-"));
    expect(run(dir, "init", "--name", "r").code).toBe(0);
    const res = run(dir, "duet", "spawn", "--name", "w");
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("--name and --pen are required");
  });
});
