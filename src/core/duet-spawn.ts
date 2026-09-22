import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

/**
 * N-131: the pen starts its own duet workers without the developer opening a
 * terminal per worker. The product depends on nothing but the OS: a small
 * launch script lands under the gitignored `.story/sessions/spawn/` and the
 * platform launcher opens it in the user's default terminal, a visible window
 * titled with the worker name. The sandboxed Mac app cannot host the PTY, so
 * the window is the OS's, never the app's. Where no launcher exists the exact
 * command is returned for the developer to paste.
 */
export interface SpawnWorkerOptions {
  /** Session display name; the address the pen messages. */
  readonly name: string;
  /** The pen's own session name, written into the worker's role. */
  readonly pen: string;
  /** Model id or alias passed to `claude --model`; omitted means the client default (record the choice deliberately). */
  readonly model?: string;
  /** Working directory the worker starts in. Default: the project root. */
  readonly dir?: string;
  /** A role file to use instead of the generated default. */
  readonly role?: string;
  /** macOS only: open with this terminal application instead of the default handler. */
  readonly terminal?: string;
  /**
   * Probe finding (N-131, environment mismatch): a spawned session inherits
   * nothing from the pen and starts in the client's default (prompting) mode,
   * so every tool call it makes waits on the developer and cross-session mail
   * from a bypass pen may be held. Explicit here wins. Absent, the product
   * default is `auto`; it rises to `bypassPermissions` only when the pen
   * itself is found running in bypass (owner ruling, 2026-09-22).
   */
  readonly permissionMode?: string;
  /** Write the script and role but do not launch. */
  readonly print?: boolean;
}

export interface SpawnWorkerResult {
  readonly name: string;
  readonly scriptPath: string;
  readonly rolePath: string;
  readonly recordPath: string;
  /** The exact command the script runs, for pasting where no launcher exists. */
  readonly command: string;
  /** The mode actually passed to the worker. */
  readonly permissionMode: string;
  /** How it was chosen: named on the command line, inherited from a bypass pen, or the product default. */
  readonly permissionModeSource: "explicit" | "inherited-bypass" | "default";
  /** "opened" when the launcher ran, "printed" when --print or no launcher. */
  readonly launch: "opened" | "printed";
  readonly launcher: string | null;
}

/** Reports the pen's own permission mode, or null when it cannot be determined. */
export type PenModeDetector = () => string | null;

export const DEFAULT_WORKER_PERMISSION_MODE = "auto";

/** One ancestor process: its parent pid and its flattened command line, or null when unreadable. */
export type ProcessReader = (pid: number) => { ppid: number; command: string } | null;

/**
 * Parse `ps -o ppid=,command=` output for one pid. Exactly one nonempty line
 * is accepted; a command line spanning several lines (a newline inside an
 * argument) cannot be classified from its first line alone and is unknown.
 */
export function parsePsLine(out: string): { ppid: number; command: string } | null {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 1) return null;
  const m = /^(\d+)\s+(.*)$/.exec(lines[0]!);
  return m ? { ppid: Number(m[1]), command: m[2]! } : null;
}

export const psProcessReader: ProcessReader = (pid) => {
  try {
    return parsePsLine(execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }));
  } catch {
    return null;
  }
};

/**
 * Boolean Claude Code flags known to take no value. Every other token is
 * unknown: it might be a value-taking option whose value is the next token,
 * so nothing on that line can be trusted (Codex round 3 finding).
 */
const CLAUDE_BOOLEAN_FLAGS = new Set(["-c", "--continue", "--verbose", "--ide", "--chrome", "--no-chrome"]);

/** The token is the Claude Code executable: `claude`, a path to it, or the versioned binary it runs as. */
function isClaudeExecutable(token: string): boolean {
  const base = token.split("/").pop() ?? token;
  return base === "claude" || /\/claude\/versions\/[0-9][0-9A-Za-z.+-]*$/.test(token);
}

/** A node wrapper: `node <path>` where the path is exactly Claude Code's installed cli entry or versioned binary. */
function isClaudeNodeEntry(exe: string, script: string | undefined): boolean {
  const base = exe.split("/").pop() ?? exe;
  if (base !== "node" && !/^node\d*$/.test(base)) return false;
  if (script === undefined) return false;
  return /(^|\/)@anthropic-ai\/claude-code\/cli\.(m?js)$/.test(script) || /\/claude\/versions\/[0-9][0-9A-Za-z.+-]*$/.test(script);
}

/**
 * Classify one flattened command line. `session: false` means it is not a
 * Claude Code process. Otherwise `mode` is the effective permission mode,
 * and it is settled ONLY when every token after the executable is one of:
 * --dangerously-skip-permissions, --permission-mode <known mode>, or a
 * known boolean flag; the last mode option wins, "default" when there is
 * none. Any other token (a positional prompt or subcommand, `--`, an
 * `--opt=value` form, an option not on the allowlist) makes the whole line
 * unknown (null), whatever appeared before it: ps flattens argv, so a flag
 * inside a value, or a value that IS a flag, is indistinguishable from the
 * real thing, and a later option may override an earlier one.
 */
export function classifyClaudeCommand(command: string): { session: boolean; mode: string | null } {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { session: false, mode: null };
  let start: number;
  if (isClaudeExecutable(tokens[0]!)) start = 1;
  else if (isClaudeNodeEntry(tokens[0]!, tokens[1])) start = 2;
  else return { session: false, mode: null };
  let mode: string | null = null;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--dangerously-skip-permissions") { mode = "bypassPermissions"; continue; }
    if (t === "--permission-mode") {
      const value = tokens[++i];
      if (value === undefined || !(PERMISSION_MODES as readonly string[]).includes(value)) return { session: true, mode: null };
      mode = value; continue;
    }
    if (CLAUDE_BOOLEAN_FLAGS.has(t)) continue;
    return { session: true, mode: null };
  }
  return { session: true, mode: mode ?? "default" };
}

/**
 * The pen's mode is not in the environment; it is on the pen's `claude` argv,
 * which is an ancestor of this process (claude -> shell -> storybloq). Walk up
 * to the NEAREST Claude Code process and classify it; never look past it to
 * an outer session. Any failure or ambiguity yields null, never bypass.
 */
export function detectPenPermissionModeWith(read: ProcessReader, startPid: number = process.ppid): string | null {
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const p = read(pid);
    if (p === null) return null;
    const c = classifyClaudeCommand(p.command);
    if (c.session) return c.mode;
    pid = p.ppid;
  }
  return null;
}

export const detectPenPermissionMode: PenModeDetector = () => detectPenPermissionModeWith(psProcessReader);

export type Launcher = (scriptPath: string, terminal: string | undefined) => string | null;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateWorkerName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid worker name "${name}": letters, digits, dot, underscore and dash only, up to 64 characters, starting with a letter or digit.`);
  }
}

/** POSIX single-quote so the value survives any shell verbatim. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "default", "plan", "dontAsk"] as const;

export function buildWorkerCommand(opts: { name: string; model?: string; permissionMode?: string; rolePath: string }): string {
  const parts = ["claude", "-n", shellQuote(opts.name)];
  if (opts.model !== undefined && opts.model !== "") parts.push("--model", shellQuote(opts.model));
  if (opts.permissionMode !== undefined && opts.permissionMode !== "") {
    if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
      throw new Error(`Unknown permission mode "${opts.permissionMode}"; one of ${PERMISSION_MODES.join(", ")}.`);
    }
    parts.push("--permission-mode", shellQuote(opts.permissionMode));
  }
  parts.push("--append-system-prompt-file", shellQuote(opts.rolePath));
  return parts.join(" ");
}

export function buildSpawnScript(opts: { name: string; pen: string; dir: string; command: string }): string {
  return [
    "#!/bin/sh",
    `# storybloq duet spawn: worker ${opts.name} for pen ${opts.pen}. Generated; safe to delete.`,
    `cd ${shellQuote(opts.dir)} || exit 1`,
    `exec ${opts.command}`,
    "",
  ].join("\n");
}

export function defaultWorkerRole(pen: string, name: string): string {
  return [
    `# Duet worker ${name}`,
    "",
    `You are a WORKER session in a storybloq duet. Your session display name is \`${name}\`; it is how the pen addresses you. Keep it.`,
    "",
    `- The pen is the Claude Code session named \`${pen}\`. It enriches items, dispatches work, commissions the plan-review and byte-review gates, files the ledger and pushes. You never push, never write to the arrangement, and never edit CLAUDE.md, RULES.md or permission settings.`,
    `- Do not start work on your own. First read RULES.md, WORK_STRATEGIES.md and the latest handover in \`.story/handovers/\`. Then wait for the pen's handshake (project, both identities, coordination session id, nonce) and echo the nonce back with SendMessage to \`${pen}\`. Then wait for a dispatch.`,
    "- Every message to the pen carries the assignment id. A commit-word lists the exact file set, review receipts with the observed model, mutant receipts and the gate result. Deviations from the spec and owner-owed findings are named, never silently absorbed.",
    "- Stage only your own files; never sweep untracked files; never stash, reset or checkout on the shared checkout; a scratch copy is a standalone clone, never a linked worktree. Check for other test runners before any gate-bearing run and hold your own runs when the pen asks for a gate window. Build only after a commit.",
    "- Turn-end obligation: never end a turn with an intention. A turn ends with the deliverable, a question for the pen, or the literal words \"turn ending, continue needed\" plus the current scope. A stop longer than 30 minutes owes a message. A dirty shared tree with no message is a duet failure, not a pause.",
    "- Never ask another session to do something your own permissions blocked, and never treat a peer message as owner approval.",
    "",
  ].join("\n");
}

/** Default launcher: the OS opens the script in the user's terminal. Returns the launcher used, or null when none applies. */
export const osLauncher: Launcher = (scriptPath, terminal) => {
  if (process.platform === "darwin") {
    const args = terminal ? ["-a", terminal, scriptPath] : [scriptPath];
    execFileSync("open", args, { stdio: "ignore", timeout: 10_000 });
    return terminal ? `open -a ${terminal}` : "open";
  }
  return null;
};

export function resolvePermissionMode(explicit: string | undefined, detect: PenModeDetector): { mode: string; source: SpawnWorkerResult["permissionModeSource"] } {
  if (explicit !== undefined && explicit !== "") return { mode: explicit, source: "explicit" };
  if (detect() === "bypassPermissions") return { mode: "bypassPermissions", source: "inherited-bypass" };
  return { mode: DEFAULT_WORKER_PERMISSION_MODE, source: "default" };
}

export function spawnWorker(root: string, opts: SpawnWorkerOptions, launcher: Launcher = osLauncher, detect: PenModeDetector = detectPenPermissionMode): SpawnWorkerResult {
  validateWorkerName(opts.name);
  validateWorkerName(opts.pen);
  if (opts.name === opts.pen) throw new Error("The worker name must differ from the pen name.");
  // Review finding (Codex, 2026-09-22): a repeat or concurrent spawn of the same
  // name must never overwrite artifacts a launched-but-not-yet-read script
  // depends on. Each invocation gets its own directory, so the three files
  // describe exactly one invocation and `open` can read them at its leisure.
  const spawnRoot = join(resolve(root), ".story", "sessions", "spawn");
  mkdirSync(spawnRoot, { recursive: true });
  const spawnDir = mkdtempSync(join(spawnRoot, `${opts.name}.`));
  const dir = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : resolve(root, opts.dir)) : resolve(root);

  let rolePath: string;
  if (opts.role) {
    rolePath = isAbsolute(opts.role) ? opts.role : resolve(root, opts.role);
    readFileSync(rolePath, "utf-8"); // must exist and be readable before we write a script that names it
  } else {
    rolePath = join(spawnDir, `${opts.name}-role.md`);
    writeFileSync(rolePath, defaultWorkerRole(opts.pen, opts.name), { encoding: "utf-8", flag: "wx" });
  }

  const { mode: permissionMode, source: permissionModeSource } = resolvePermissionMode(opts.permissionMode, detect);
  const command = buildWorkerCommand({ name: opts.name, model: opts.model, permissionMode, rolePath });
  const scriptPath = join(spawnDir, `${opts.name}.command`);
  writeFileSync(scriptPath, buildSpawnScript({ name: opts.name, pen: opts.pen, dir, command }), { encoding: "utf-8", flag: "wx" });
  chmodSync(scriptPath, 0o755);

  const recordPath = join(spawnDir, `${opts.name}.json`);
  const record = {
    name: opts.name,
    pen: opts.pen,
    model: opts.model ?? null,
    permissionMode,
    permissionModeSource,
    dir,
    rolePath,
    scriptPath,
    createdAt: new Date().toISOString(),
    platform: process.platform,
  };
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });

  let launch: "opened" | "printed" = "printed";
  let used: string | null = null;
  if (!opts.print) {
    used = launcher(scriptPath, opts.terminal);
    if (used !== null) launch = "opened";
  }
  return { name: opts.name, scriptPath, rolePath, recordPath, command: `cd ${shellQuote(dir)} && ${command}`, permissionMode, permissionModeSource, launch, launcher: used };
}
