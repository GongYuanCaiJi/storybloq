/**
 * T-502 check 3: Codex is installed, but is the review bridge registered.
 *
 * The check answers only what it can prove. Two ideas keep it honest:
 *
 * NAMES RESOLVE, ENTRIES CLASSIFY. Claude Code resolves an MCP server BY
 * NAME across three scopes (local > project > user), so for each name only
 * the highest-precedence definition exists as far as the running client is
 * concerned. A user-level bridge shadowed by a local entry of the same name
 * is NOT running, and counting it would produce a confident ok for a bridge
 * that cannot answer.
 *
 * A BRIDGE-RELATED NAME IS A CLAIM WE MUST NOT CONTRADICT. If a name looks
 * like the bridge but its launch form is not one we recognise, the answer is
 * `skip` "cannot verify" -- never `advise`. Telling a user to register a
 * bridge they have already registered in a form we simply do not parse is the
 * failure mode this rule exists to prevent. Classification is by launcher
 * grammar only: arguments never make a name bridge-related, so `echo
 * codex-claude-bridge@latest` under an unrelated name is not the bridge.
 */

import { basename, join } from "node:path";
import { readJsonObject, skipCheck, adviseCheck, okCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "codex-bridge" as const;

/** `~/.claude.json` holds project state and is routinely hundreds of KiB. */
export const CLAUDE_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const CODEX_PROBE_CAP_MS = 2000;

const BRIDGE_PACKAGE = "codex-claude-bridge";
const BRIDGE_NAMES = new Set(["codex-bridge", "codex-bridge-local"]);

type Scope = "local" | "project" | "user";

/** Lower number wins. Only a scope ABOVE a winner can shadow it. */
const PRECEDENCE: Readonly<Record<Scope, number>> = { local: 0, project: 1, user: 2 };
type Classification = "bridge" | "unverifiable" | "not-bridge";

/** A name is bridge-related from its NAME alone. Arguments never qualify it. */
export function isBridgeRelatedName(name: string): boolean {
  return BRIDGE_NAMES.has(name) || name.includes(BRIDGE_PACKAGE);
}

/**
 * The three launcher grammars, matched exactly. No flag skipping: an
 * unrecognised leading flag fails the grammar rather than being stepped over,
 * because `npx -p codex-claude-bridge@latest echo` installs the package and
 * runs something else entirely.
 */
export function isBridgeLaunch(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const command = (entry as Record<string, unknown>).command;
  const rawArgs = (entry as Record<string, unknown>).args;
  if (typeof command !== "string") return false;
  if (rawArgs !== undefined && !(Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string"))) return false;
  const args: string[] = Array.isArray(rawArgs) ? (rawArgs as string[]) : [];
  const base = basename(command);

  // (a) the bridge's own binary, any arguments.
  if (base === BRIDGE_PACKAGE) return true;

  // (b) node or bun running a path that contains the exact package segment.
  if (base === "node" || base === "bun") {
    const first = args[0];
    if (first === undefined || first.startsWith("-")) return false;
    return first.split(/[\\/]/).includes(BRIDGE_PACKAGE);
  }

  // (c) npx or bunx, an optional single -y/--yes, then the package, then any
  // trailing application arguments.
  if (base === "npx" || base === "bunx") {
    let i = 0;
    if (args[0] === "-y" || args[0] === "--yes") i = 1;
    const pkg = args[i];
    if (pkg === undefined) return false;
    return pkg === BRIDGE_PACKAGE || pkg.startsWith(`${BRIDGE_PACKAGE}@`);
  }

  return false;
}

function classify(name: string, entry: unknown): Classification {
  if (isBridgeLaunch(entry)) return "bridge";
  return isBridgeRelatedName(name) ? "unverifiable" : "not-bridge";
}

export async function checkCodexBridge(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  const base = { projectDir: ctx.projectDir };
  if (ctx.client === "codex") {
    return skipCheck(ID, "The codex-claude-bridge is a Claude Code MCP server, so this check does not apply when running under Codex.", "the bridge is a Claude Code MCP server", base);
  }

  const remaining = ctx.deadline - deps.now();
  const probe = deps.run("codex", ["--version"], Math.max(1, Math.min(CODEX_PROBE_CAP_MS, remaining)));
  if (probe.kind === "enoent") {
    return skipCheck(ID, "Codex is not installed, so there is no Codex review backend to register.", "Codex is not installed", base);
  }
  if (probe.kind !== "ok") {
    return skipCheck(
      ID,
      "`codex --version` did not answer, so Storybloq cannot tell whether Codex is installed.",
      "codex --version did not answer",
      { ...base, probe: probe.kind },
    );
  }

  const claudeJsonPath = join(deps.homeDir, ".claude.json");
  const mcpJsonPath = join(ctx.projectDir, ".mcp.json");
  const claudeJson = readJsonObject(deps, claudeJsonPath, CLAUDE_JSON_MAX_BYTES);
  const mcpJson = readJsonObject(deps, mcpJsonPath, CLAUDE_JSON_MAX_BYTES);

  // Each scope resolves to a server map or to "unknown". A nested field that
  // is PRESENT but the wrong shape is unknown, not empty: a malformed
  // `projects` block or a malformed `disabledMcpjsonServers` array leaves
  // real registration evidence unresolved, and treating it as an empty map
  // would let a lower scope look like the winner (or produce a
  // register-the-bridge advisory) on evidence we never actually read.
  const local = resolveLocalScope(claudeJson, claudeJsonPath, ctx.projectDir);
  const user = resolveUserScope(claudeJson, claudeJsonPath);
  const project = resolveProjectScope(mcpJson, mcpJsonPath, local.disabled, claudeJsonPath);

  // Winning definition per name, highest precedence first.
  const scopes: ReadonlyArray<{ scope: Scope; read: ScopeRead }> = [
    { scope: "local", read: local.read },
    { scope: "project", read: project },
    { scope: "user", read: user },
  ];
  const winners = new Map<string, { scope: Scope; entry: unknown }>();
  for (const { scope, read } of scopes) {
    if (read.kind !== "ok") continue;
    for (const [name, entry] of Object.entries(read.servers)) {
      if (!winners.has(name)) winners.set(name, { scope, entry });
    }
  }

  // An unreadable source is only harmless BELOW a proven winner. `~/.claude.json`
  // carries the local scope, which outranks everything, so when it cannot be
  // read no winner at all is trustworthy; an unreadable `.mcp.json` still
  // leaves a LOCAL winner standing, because nothing shadows the local scope.
  const unreadable: ReadonlyArray<{ path: string; highest: number }> = scopes
    .filter((s): s is { scope: Scope; read: Extract<ScopeRead, { kind: "indeterminate" }> } => s.read.kind === "indeterminate")
    .map((s) => ({ path: s.read.path, highest: PRECEDENCE[s.scope] }));

  for (const [name, { scope, entry }] of winners) {
    if (classify(name, entry) !== "bridge") continue;
    if (unreadable.some((u) => u.highest < PRECEDENCE[scope])) continue; // could be shadowed
    return okCheck(ID, `Codex is installed and the codex-claude-bridge review backend is registered as \`${name}\`.`, {
      ...base,
      scope,
      name,
    });
  }

  // No trustworthy bridge. An unreadable source now decides the answer: it
  // could shadow what we did find, or supply the bridge we did not.
  if (unreadable.length > 0) {
    const { path } = unreadable[0]!;
    return skipCheck(
      ID,
      `Storybloq could not read ${path}, so it cannot tell whether the codex-claude-bridge review backend is registered.`,
      `unreadable: ${path}`,
      base,
    );
  }

  for (const [name, { scope, entry }] of winners) {
    if (classify(name, entry) === "unverifiable") {
      return skipCheck(
        ID,
        `The MCP server \`${name}\` looks like the codex-claude-bridge but Storybloq does not recognise how it is launched, so it cannot confirm the review backend is working.`,
        `cannot verify ${name}`,
        { ...base, scope, name },
      );
    }
  }

  return adviseCheck(
    ID,
    "Codex is installed but the codex-claude-bridge review backend is not registered for Claude Code. Register it with `claude mcp add codex-bridge -s user -- npx -y codex-claude-bridge@latest`.",
    base,
  );
}

/** A scope's server map, or an admission that we could not establish it. */
type ScopeRead =
  | { readonly kind: "ok"; readonly servers: Record<string, unknown> }
  | { readonly kind: "indeterminate"; readonly path: string };

type JsonRead = ReturnType<typeof readJsonObject>;

/** A nested field: missing, present and an object, or present and malformed. */
type Field<T> = { readonly kind: "absent" } | { readonly kind: "ok"; readonly value: T } | { readonly kind: "malformed" };

function objectField(container: Record<string, unknown>, key: string): Field<Record<string, unknown>> {
  const value = container[key];
  if (value === undefined || value === null) return { kind: "absent" };
  return typeof value === "object" && !Array.isArray(value)
    ? { kind: "ok", value: value as Record<string, unknown> }
    : { kind: "malformed" };
}

function stringArrayField(container: Record<string, unknown>, key: string): Field<readonly string[]> {
  const value = container[key];
  if (value === undefined || value === null) return { kind: "absent" };
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { kind: "malformed" };
  return { kind: "ok", value: value as readonly string[] };
}

/**
 * LOCAL scope plus the project's `.mcp.json` disablement list, which lives in
 * the same file. Both are returned together because one parse yields both and
 * the disablement list decides what the PROJECT scope contains.
 */
function resolveLocalScope(
  claudeJson: JsonRead,
  path: string,
  projectDir: string,
): { read: ScopeRead; disabled: Field<readonly string[]> } {
  // An ABSENT file is a determinate empty answer; only an unreadable one is unknown.
  if (claudeJson.kind === "indeterminate") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (claudeJson.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const projects = objectField(claudeJson.value, "projects");
  if (projects.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (projects.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const entry = objectField(projects.value, projectDir);
  if (entry.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled: { kind: "malformed" } };
  if (entry.kind === "absent") return { read: { kind: "ok", servers: {} }, disabled: { kind: "absent" } };
  const servers = objectField(entry.value, "mcpServers");
  const disabled = stringArrayField(entry.value, "disabledMcpjsonServers");
  if (servers.kind === "malformed") return { read: { kind: "indeterminate", path }, disabled };
  return { read: { kind: "ok", servers: servers.kind === "ok" ? servers.value : {} }, disabled };
}

function resolveUserScope(claudeJson: JsonRead, path: string): ScopeRead {
  if (claudeJson.kind === "indeterminate") return { kind: "indeterminate", path };
  if (claudeJson.kind === "absent") return { kind: "ok", servers: {} };
  const servers = objectField(claudeJson.value, "mcpServers");
  if (servers.kind === "malformed") return { kind: "indeterminate", path };
  return { kind: "ok", servers: servers.kind === "ok" ? servers.value : {} };
}

/**
 * PROJECT scope: `.mcp.json`'s servers minus the names the local scope
 * disabled. A malformed disablement list makes this scope unknown even when
 * `.mcp.json` itself read cleanly, and names the file the list lives in --
 * that is where the user has to look.
 */
function resolveProjectScope(
  mcpJson: JsonRead,
  path: string,
  disabled: Field<readonly string[]>,
  disabledPath: string,
): ScopeRead {
  if (mcpJson.kind === "indeterminate") return { kind: "indeterminate", path };
  if (mcpJson.kind === "absent") return { kind: "ok", servers: {} };
  const servers = objectField(mcpJson.value, "mcpServers");
  if (servers.kind === "malformed") return { kind: "indeterminate", path };
  const raw = servers.kind === "ok" ? servers.value : {};
  if (Object.keys(raw).length === 0) return { kind: "ok", servers: {} };
  if (disabled.kind === "malformed") return { kind: "indeterminate", path: disabledPath };
  const names = new Set(disabled.kind === "ok" ? disabled.value : []);
  const kept: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!names.has(name)) kept[name] = entry;
  }
  return { kind: "ok", servers: kept };
}
