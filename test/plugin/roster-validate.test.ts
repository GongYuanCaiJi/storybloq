import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALLS, EVENTS } from "../../plugins/storybloq/hooks/client-api.js";
import { register, type On } from "../../plugins/storybloq/hooks/mod.js";

/**
 * T-507: what the whole hooks module hooks and calls once the roster Mod is
 * wired beside the sidebar, read from the client's own scan rather than from
 * our reading of our own source (`claude plugin validate`).
 *
 * The scan follows imports from mod.ts, so it prints ONE list for both Mods.
 * The roster registers the four events it shares with the sidebar under a
 * matcher (the client refuses the same event twice without one), which the
 * scan prints as `event{key=/./}`. The union pinned here is the contract:
 * a `$.fs.write` added to the roster's graph, or a `$.process.run` reached
 * from anywhere but the roster's `runCli`, fails it.
 */

const PLUGIN_DIR = join(__dirname, "..", "..", "plugins", "storybloq");

/** The roster's six registrations, then the sidebar's six, as the scan orders them (mod.ts wires the roster first). */
const EXPECTED_HOOKS = [
  `${EVENTS.sessionStart}{cwd=/^/}`,
  EVENTS.agentSpawn,
  `${EVENTS.turnComplete}{turnId=/./}`,
  `${EVENTS.toolCall}{tool=/./}`,
  `${EVENTS.sessionCompact}{trigger=/./}`,
  EVENTS.sessionDetach,
  EVENTS.uiRender,
  EVENTS.sessionStart,
  EVENTS.turnComplete,
  EVENTS.toolCall,
  EVENTS.sessionCompact,
  EVENTS.uiClose,
];

const EXPECTED_CALLS = [...new Set([...CALLS.roster, ...CALLS.sidebar])].sort();

function clientAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function validateOutput(): string {
  return execFileSync("claude", ["plugin", "validate", PLUGIN_DIR], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" },
  });
}

/** The raw entries after a label, parentheticals kept: "$.process.run (via runCli)". */
function entriesAfter(output: string, label: string): string[] {
  const line = output.split("\n").find((row) => row.includes(`${label}:`));
  if (line === undefined) return [];
  const after = line.slice(line.indexOf(`${label}:`) + label.length + 1);
  // A "(via a, b)" carries commas of its own: split outside parentheses only.
  return after
    .split(/,(?![^(]*\))/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const stripVia = (entry: string) => entry.replace(/\s*\(via[^)]*\)/g, "");

const available = clientAvailable();

describe("roster Mod contract, as the client scans it (T-507)", () => {
  if (!available) {
    it("needs the claude client on PATH to read the contract", () => {
      expect.fail("claude is not on PATH, so `claude plugin validate` cannot be run and the Mod's hooks and calls are unchecked");
    });
    return;
  }

  const output = validateOutput();

  it("passes the client's own validation with both Mods wired", () => {
    expect(output).toContain("Validation passed");
  });

  it("registers the roster's events when, and only when, the `roster` option is on", () => {
    // Behavioural, not a source substring: the scan follows the import
    // whether or not `register` ever calls `registerRoster`.
    const seen = (options: Record<string, boolean>): string[] => {
      const events: string[] = [];
      register(((event: string) => { events.push(event); return { catch: () => undefined }; }) as unknown as On, options);
      return events;
    };
    expect(seen({ roster: true })).toEqual([
      EVENTS.sessionStart,
      EVENTS.agentSpawn,
      EVENTS.turnComplete,
      EVENTS.toolCall,
      EVENTS.sessionCompact,
      EVENTS.sessionDetach,
    ]);
    expect(seen({})).toEqual([]);
  });

  it("hooks the roster's six events under matchers where the sidebar hooks the same event, then the sidebar's six", () => {
    expect(entriesAfter(output, "mod.ts hooks")).toEqual(EXPECTED_HOOKS);
  });

  it("makes exactly the union of the two pinned call lists", () => {
    expect(entriesAfter(output, "mod.ts calls").map(stripVia).sort()).toEqual(EXPECTED_CALLS);
  });

  it("reaches the host process only from the roster's one CLI call site, and never writes a file or calls a server", () => {
    const entries = entriesAfter(output, "mod.ts calls");
    expect(entries.find((e) => e.startsWith("$.process.run"))).toBe("$.process.run (via runCli)");
    expect(entries.map(stripVia)).not.toContain("$.fs.write");
    expect(entries.map(stripVia)).not.toContain("$.mcp.call");
  });

  it("reads exactly one environment variable, the client's session id, and writes none", () => {
    expect(entriesAfter(output, "mod.ts env reads")).toEqual(["CLAUDE_CODE_SESSION_ID"]);
    expect(entriesAfter(output, "mod.ts env writes")).toEqual(["nothing"]);
  });

  it("ships the Mod's own tests and the binary resolver beside it", () => {
    for (const name of ["roster.ts", "roster.test.ts", "install.ts"]) {
      expect(() => readFileSync(join(PLUGIN_DIR, "hooks", name))).not.toThrow();
    }
  });
});
