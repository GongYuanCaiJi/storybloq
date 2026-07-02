import { describe, it, expect } from "vitest";
import yargs from "yargs";
import { registerTeamCommand } from "../../src/cli/register.js";

/**
 * ISS-734: the --id-allocator help string must name the local-vs-git-refs
 * tradeoff in one sentence, so the choice is informed at the point it is made.
 * Renders `team init --help` through the real yargs registration.
 */
async function teamInitHelp(): Promise<string> {
  const parser = registerTeamCommand(yargs([])).exitProcess(false);
  return await new Promise<string>((resolve, reject) => {
    parser.parse(["team", "init", "--help"], (err: Error | undefined, _argv: unknown, output: string) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

describe("ISS-734: team init --id-allocator help text", () => {
  it("names both allocators and the collision tradeoff", async () => {
    const help = await teamInitHelp();
    expect(help).toContain("--id-allocator");
    expect(help).toContain("local");
    expect(help).toContain("git-refs");
    // The tradeoff, not just the enum: local can mint duplicates across
    // divergent branches; git-refs prevents collisions at the source.
    expect(help.toLowerCase()).toContain("duplicate");
    expect(help.toLowerCase()).toContain("reconcile");
  });
});
