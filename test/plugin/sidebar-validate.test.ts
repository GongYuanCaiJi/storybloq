import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CALLS, EVENTS, CLIENT_API_VERSION } from "../../plugins/storybloq/hooks/client-api.js";

/**
 * T-508: what the ledger sidebar Mod hooks and calls, read from the client
 * rather than from our own reading of our own source.
 *
 * `claude plugin validate` scans a hooks module and everything it imports and
 * prints two lists: the events it hooks and the calls it makes on `$`. That
 * printed list IS the read-only contract. A `$.fs.write` added anywhere in the
 * sidebar's graph shows up in it, which is the mutant M-FS-WRITE; so would a
 * `$.process.run` or a `$.mcp.call`, the other two ways this Mod could stop
 * being read-only.
 *
 * The scan is static and needs no session, no network and no authentication,
 * but it does need the client on PATH. Where it is absent (a CI box with no
 * Claude Code) the check cannot run and says so rather than passing quietly.
 */

const PLUGIN_DIR = join(__dirname, "..", "..", "plugins", "storybloq");

/** The six events the Mod hooks, from the pinned names in client-api.ts. */
const EXPECTED_HOOKS = [
  EVENTS.uiRender,
  EVENTS.sessionStart,
  EVENTS.turnComplete,
  EVENTS.toolCall,
  EVENTS.sessionCompact,
  EVENTS.uiClose,
];

/**
 * The calls the Mod makes, taken from the pin rather than restated here.
 *
 * `client-api.ts` is the documentary list and this is the reading the client
 * itself produces, so asserting one against the other is the whole point: a
 * call added to the Mod and not to the pin fails, and so does a pin that
 * declares a call the Mod does not make. `$.ui.close` was in that list until
 * the sidebar landed and it turned out the Mod only HOOKS `ui.close`; the
 * person closes the pane, the Mod never does.
 */
const EXPECTED_CALLS = [...CALLS.sidebar].sort();

const FORBIDDEN_CALLS = ["$.fs.write", "$.process.run", "$.mcp.call"];

function clientAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a copy of the plugin whose hooks module wires the sidebar ALONE.
 * The real `mod.ts` wires the roster Mod beside it (T-507), and the scan
 * follows imports and prints one list for the whole graph, so validating the
 * real plugin could not tell a sidebar call from a roster call: a `$` call
 * the sidebar dropped would still be supplied by the roster. The copy keeps
 * this file's contract exact; test/plugin/roster-validate.test.ts pins the
 * union the real module prints.
 */
function validateOutput(): string {
  const realMod = readFileSync(join(PLUGIN_DIR, "hooks", "mod.ts"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "storybloq-sidebar-validate-"));
  try {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    // `skills` points at a directory this copy does not carry.
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    delete manifest["skills"];
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
    for (const name of ["hooks.json", "client-api.ts", "sidebar.ts", "sidebar-projection.ts"]) {
      copyFileSync(join(PLUGIN_DIR, "hooks", name), join(dir, "hooks", name));
    }
    const withoutImport = realMod.replace(/^import \{ registerRoster \} from "\.\/roster\.js";\n/m, "");
    expect(withoutImport, "mod.ts no longer carries the roster import this copy removes").not.toBe(realMod);
    const sidebarOnly = withoutImport.replace(/^\s*if \(roster\) registerRoster\(on, options\);\n/m, "");
    expect(sidebarOnly, "mod.ts no longer carries the roster wiring line this copy removes").not.toBe(withoutImport);
    expect(sidebarOnly).not.toContain("roster.js");
    expect(sidebarOnly).not.toMatch(/\bregisterRoster\b/);
    writeFileSync(join(dir, "hooks", "mod.ts"), sidebarOnly);
    return execFileSync("claude", ["plugin", "validate", dir], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * "a, b (via f), c" to ["a", "b", "c"]: the scan names where a call came from.
 * The label carries the module name because "Validating hooks: <path>" is also
 * a line with "hooks:" in it, and it comes first.
 */
function listAfter(output: string, label: string): string[] {
  const line = output.split("\n").find((row) => row.includes(`${label}:`));
  if (line === undefined) return [];
  const after = line.slice(line.indexOf(`${label}:`) + label.length + 1);
  // "(via readHeader, startScan)" carries a comma of its own, so the
  // parenthetical goes before the split, not after it.
  return after
    .replace(/\s*\(via[^)]*\)/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const available = clientAvailable();

describe("sidebar Mod contract, as the client scans it (T-508)", () => {
  if (!available) {
    it("needs the claude client on PATH to read the contract", () => {
      expect.fail(
        "claude is not on PATH, so `claude plugin validate` cannot be run and the Mod's hooks and calls are unchecked",
      );
    });
    return;
  }

  const output = validateOutput();

  it("passes the client's own validation", () => {
    expect(output).toContain("Validation passed");
  });

  it("hooks exactly the six events the design names", () => {
    expect(listAfter(output, "mod.ts hooks")).toEqual(EXPECTED_HOOKS);
  });

  it("makes exactly the calls the pinned list declares", () => {
    expect(listAfter(output, "mod.ts calls").slice().sort()).toEqual(EXPECTED_CALLS);
  });

  it("makes no call that could write, run or reach a server", () => {
    // M-FS-WRITE: add a $.fs.write anywhere in the sidebar's graph and this
    // fails, because the scan follows imports.
    const calls = listAfter(output, "mod.ts calls");
    for (const forbidden of FORBIDDEN_CALLS) {
      expect(calls, `the sidebar is read-only and must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("was read from the client version the pin names", () => {
    const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    expect(
      version.startsWith(CLIENT_API_VERSION),
      `client-api.ts pins ${CLIENT_API_VERSION} but this machine runs ${version}; re-read the API and update the pin`,
    ).toBe(true);
  });

  it("declares the plugin exists but leaves the Mod off by default", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
      userConfig?: { sidebar?: { default?: unknown } };
    };
    expect(manifest.userConfig?.sidebar?.default).toBe(false);
  });

  it("ships the Mod's own tests beside it", () => {
    expect(existsSync(join(PLUGIN_DIR, "hooks", "sidebar.test.ts"))).toBe(true);
  });
});
