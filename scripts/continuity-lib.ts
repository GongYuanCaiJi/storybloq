/**
 * T-525: the continuity evaluation's pure logic -- stream parsing, token
 * accounting, validity, completion, sanitisation, hashing, materialisation.
 *
 * Nothing here spawns a session or calls a model; `continuity-run.ts` wires
 * these into the real dispatcher and `test/tooling/continuity-run.test.ts`
 * exercises them against synthetic streams. Every rule in this file is the
 * rule frozen in `test/fixtures/continuity/rubric.md` and plan rev 4.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { basename, join, relative, sep, posix } from "node:path";

// --- hashing --------------------------------------------------------------

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Directories and files a live session or a stray CLI call writes under .story/; never part of the fixture identity and never copied into a working copy. */
export const VOLATILE_STORY_ENTRIES = ["sessions", "snapshots", "telemetry", "servers", "status.json"] as const;

/**
 * Sorted relative path plus bytes, one hash for a whole tree. node_modules and .git are skipped, and the
 * volatile entries are skipped only when they sit directly under a `.story` directory (or under a root the
 * caller marks as a ledger with `skip`). A symlink is inventoried as a link: its target path is hashed, and the
 * target's bytes too when it points at a file, so a symlinked extra file is visible to every inventory diff.
 */
export function hashTree(root: string, opts: { readonly skip?: readonly string[] } = {}): { readonly sha256: string; readonly files: readonly string[]; readonly links: readonly string[] } {
  const skip = new Set(["node_modules", ".git", ...(opts.skip ?? [])]);
  const volatile = new Set<string>(VOLATILE_STORY_ENTRIES);
  const files: string[] = [];
  const links: string[] = [];
  const walk = (dir: string): void => {
    const underStory = basename(dir) === ".story";
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      if (underStory && volatile.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  const h = createHash("sha256");
  const rel: string[] = [];
  const relLinks: string[] = [];
  for (const f of files) {
    const r = relative(root, f).split(sep).join("/");
    rel.push(r);
    h.update(r).update("\0").update(readFileSync(f)).update("\0");
  }
  for (const l of links) {
    const r = relative(root, l).split(sep).join("/");
    relLinks.push(r);
    h.update(r).update("\0link\0").update(readlinkSync(l)).update("\0");
    try { if (statSync(l).isFile()) h.update(readFileSync(l)).update("\0"); } catch { h.update("<dangling>").update("\0"); }
  }
  return { sha256: h.digest("hex"), files: rel, links: relLinks };
}

/** One hash over several trees and files, in the given order, each keyed by its label. */
export function hashInputs(entries: readonly { readonly label: string; readonly path: string }[]): string {
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(e.label).update("\0");
    if (!existsSync(e.path)) {
      h.update("<absent>").update("\0");
    } else if (statSync(e.path).isDirectory()) {
      h.update(hashTree(e.path).sha256).update("\0");
    } else {
      h.update(readFileSync(e.path)).update("\0");
    }
  }
  return h.digest("hex");
}

/** The executable and fixture inputs whose hash is the experiment's identity; output directories are exempt. */
export const INPUT_PATHS = [
  "src", "plugins", "scripts", "package.json", "package-lock.json", "tsup.config.ts", "vitest.config.ts",
  "test/fixtures/continuity/core", "test/fixtures/continuity/overlays", "test/fixtures/continuity/variants",
  "test/fixtures/continuity/facts.json", "test/fixtures/continuity/fixture-map.json", "test/fixtures/continuity/rubric.md",
] as const;

/**
 * ISS-1273: the fixture material that defines the TASKS, and so must be byte-identical across arms. The overlays
 * and src are expected to change between arms; these five never may. Labels are the PKG_ROOT-relative paths,
 * which is the form that reproduces the arm-1 value pinned in the issue.
 */
export const TASK_MATERIAL = ["core", "variants", "facts.json", "fixture-map.json", "rubric.md"] as const;

export function taskMaterialEntries(pkgRoot: string): { readonly label: string; readonly path: string }[] {
  return TASK_MATERIAL.map((m) => { const label = `test/fixtures/continuity/${m}`; return { label, path: join(pkgRoot, label) }; });
}

/** One hash per entry (each is hashInputs over that entry alone); a walk that throws is kept as an error for its label. */
export function hashInputsByPath(entries: readonly { readonly label: string; readonly path: string }[]): { readonly hashes: Record<string, string>; readonly errors: Record<string, string> } {
  const hashes: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const e of entries) {
    try { hashes[e.label] = hashInputs([e]); } catch (err) { errors[e.label] = err instanceof Error ? err.message : String(err); }
  }
  return { hashes, errors };
}

/** The rolled task-material hash and its per-path breakdown. The rolled value cannot be rebuilt from the parts, so both are recorded. */
export function taskMaterial(pkgRoot: string): { readonly sha256: string; readonly paths: Record<string, string> } {
  const entries = taskMaterialEntries(pkgRoot);
  const { hashes, errors } = hashInputsByPath(entries);
  const failed = Object.keys(errors);
  if (failed.length) throw new Error(`task material unreadable: ${failed.map((l) => `${l} (${errors[l]})`).join(", ")}`);
  return { sha256: hashInputs(entries), paths: hashes };
}

/** Labels whose value differs, or which only one side has; sorted. */
export function driftedPaths(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].filter((k) => !(k in expected) || !(k in actual) || expected[k] !== actual[k]).sort();
}

/**
 * ISS-1274: inputs a cell cannot reach under a no-rebuild run. A plugins-source edit changes nothing a cell executes
 * while dist is unchanged (the cells run dist/ and an isolated config), so it is disclosed rather than invalidating.
 * Everything else, and any label not listed, reaches the cell or its identity and invalidates.
 */
export const NON_EXECUTED_INPUTS = ["plugins"] as const;

export function classifyInputDrift(paths: readonly string[], distUnchanged: boolean): { readonly invalidating: string[]; readonly disclosed: string[] } {
  const invalidating: string[] = [];
  const disclosed: string[] = [];
  for (const p of paths) {
    if (distUnchanged && (NON_EXECUTED_INPUTS as readonly string[]).includes(p)) disclosed.push(p);
    else invalidating.push(p);
  }
  return { invalidating, disclosed };
}

// --- experiment identity --------------------------------------------------

export interface ExperimentInputs {
  readonly arm: 1 | 2 | 3;
  readonly inputTreeHash: string;
  readonly buildManifestHash: string;
  readonly model: string;
  readonly effort: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
  readonly clientVersion: string;
  readonly isolation: "fresh" | "shared";
  /** The effective client configuration (shared: the live config dir; fresh: the provisioned template). */
  readonly configHash: string;
}

/** Stable inputs only: never attempt paths, timestamps, session ids, HEAD or post-run evidence. */
export function experimentHash(i: ExperimentInputs): string {
  return sha256(
    JSON.stringify({
      arm: i.arm,
      inputTreeHash: i.inputTreeHash,
      buildManifestHash: i.buildManifestHash,
      model: i.model,
      effort: i.effort,
      timeoutMs: i.timeoutMs,
      maxBudgetUsd: i.maxBudgetUsd,
      clientVersion: i.clientVersion,
      isolation: i.isolation,
      configHash: i.configHash,
    }),
  );
}

export function cellKey(experiment: string, task: string, repeat: number): string {
  return `${experiment}:${task}:${repeat}`;
}

// --- fixture materialisation ----------------------------------------------

export interface Variant {
  readonly title: string;
  readonly description: string;
}

export const TASKS = ["T-2.a", "T-2.b", "T-2.c", "T-3", "T-4"] as const;
export type Task = (typeof TASKS)[number];

export function ticketIdForTask(task: Task): string {
  return task.startsWith("T-2") ? "T-2" : task;
}

export function variantFileForTask(task: Task): string | null {
  return task.startsWith("T-2") ? `variants/${task}.json` : null;
}

/** Copies core (plus the arm overlay) into `dest`, applies the variant, returns what was applied. */
export function materialize(fixtureRoot: string, arm: 1 | 2 | 3, task: Task, dest: string): {
  readonly variant: Variant | null;
  readonly variantSha256: string | null;
  readonly overlay: string | null;
} {
  mkdirSync(dest, { recursive: true });
  cpSync(join(fixtureRoot, "core"), dest, { recursive: true, filter: (src) => !VOLATILE_STORY_ENTRIES.includes(basename(src) as never) || !src.includes(`${sep}.story${sep}`) });
  let overlay: string | null = null;
  if (arm === 3) {
    overlay = join(fixtureRoot, "overlays", "arm3");
    const overlayStory = join(overlay, ".story");
    if (existsSync(overlayStory)) cpSync(overlayStory, join(dest, ".story"), { recursive: true });
  }
  const vf = variantFileForTask(task);
  if (vf === null) return { variant: null, variantSha256: null, overlay };
  const raw = readFileSync(join(fixtureRoot, vf));
  const variant = JSON.parse(raw.toString("utf-8")) as Variant;
  const ticketPath = join(dest, ".story", "tickets", `${ticketIdForTask(task)}.json`);
  const ticket = JSON.parse(readFileSync(ticketPath, "utf-8")) as Record<string, unknown>;
  writeFileSync(ticketPath, `${JSON.stringify({ ...ticket, title: variant.title, description: variant.description }, null, 2)}\n`);
  return { variant, variantSha256: sha256(raw), overlay };
}

/** P-3: variant (c) must carry neither the discovery keyword nor an implementation path; (b) names no path. */
export function variantDiscoveryViolations(task: Task, v: Variant): string[] {
  const text = `${v.title}\n${v.description}`;
  const out: string[] = [];
  if (task === "T-2.c" && /logging/i.test(text)) out.push("variant c contains the word logging");
  if ((task === "T-2.c" || task === "T-2.b") && /\bsrc\//.test(text)) out.push(`variant ${task.slice(-1)} names a src/ path`);
  return out;
}

// --- stream-json parsing ----------------------------------------------------

export interface StreamEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly request_id?: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: {
    readonly model?: string;
    readonly role?: string;
    readonly usage?: Record<string, unknown>;
    readonly content?: readonly ContentBlock[] | string;
  };
  readonly [key: string]: unknown;
}

export interface ContentBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly text?: string;
  readonly is_error?: boolean;
}

/**
 * Tolerates exactly one incomplete final line (a killed session), reported as `truncatedTail`. Any other line
 * that is not a JSON object with a string `type` is corruption: it is counted and sampled, never silently
 * dropped, and `validity` turns a corrupt stream into an invalid attempt.
 */
export function parseStream(text: string): { readonly events: StreamEvent[]; readonly truncatedTail: string | null; readonly corruptLines: number; readonly corruptSamples: readonly string[] } {
  const events: StreamEvent[] = [];
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let truncatedTail: string | null = null;
  let corruptLines = 0;
  const corruptSamples: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let parsed: unknown;
    let ok = false;
    try { parsed = JSON.parse(line); ok = true; } catch { ok = false; }
    if (ok && isWellFormedEvent(parsed)) {
      events.push(parsed);
    } else if (!ok && !terminated && i === lines.length - 1) {
      truncatedTail = line;
    } else {
      corruptLines++;
      if (corruptSamples.length < 5) corruptSamples.push(line.slice(0, 120));
    }
  }
  return { events, truncatedTail, corruptLines, corruptSamples };
}

/** The envelope shape summarizeStream consumes: an object with a string type; message, when present, an object whose content is a string or an array of typed blocks. */
export function isWellFormedEvent(v: unknown): v is StreamEvent {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.type !== "string") return false;
  if (e.message === undefined) return true;
  if (e.message === null || typeof e.message !== "object" || Array.isArray(e.message)) return false;
  const m = e.message as Record<string, unknown>;
  if (m.usage !== undefined && (m.usage === null || typeof m.usage !== "object")) return false;
  if (m.content === undefined || typeof m.content === "string") return true;
  if (!Array.isArray(m.content)) return false;
  return m.content.every((b) => b !== null && typeof b === "object" && !Array.isArray(b) && typeof (b as { type?: unknown }).type === "string");
}

export function usageContext(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null;
  const n = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  if (typeof usage.input_tokens !== "number") return null;
  return n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
}

export function toolResultText(block: ContentBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "object" && p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n");
  return "";
}

const GUIDE_TOOL = /storybloq_autonomous_guide$/;

export interface ToolCallRecord {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly result: string;
  readonly isError: boolean;
  readonly requestId: string | null;
  readonly parentToolUseId: string | null;
  /** Index of the assistant event that issued the call. */
  readonly issuedAt: number;
  /** Index of the user event that carried the result, or null when the stream ended first. */
  readonly resolvedAt: number | null;
  readonly beforeFirstPlanWritten: boolean;
}

export interface UsageSummary {
  /** Context at the first PLAN entry (the headline), null when PLAN was never entered. */
  readonly planEntryContext: number | null;
  /** Every PLAN entry's context, in order; null when the request at that checkpoint carried no usage. */
  readonly planEntries: readonly (number | null)[];
  readonly beforePlanWrittenContext: number | null;
  readonly totalInputTokens: number;
  readonly mainRequests: number;
  readonly mainModels: readonly string[];
  readonly subagentModels: readonly string[];
  readonly guideStates: readonly { readonly state: string; readonly sessionId: string | null; readonly toolUseId: string }[];
  readonly guideSessionId: string | null;
  readonly firstPlanWrittenToolUseId: string | null;
  readonly resultEvent: StreamEvent | null;
  readonly initEvent: StreamEvent | null;
}

/** Dedupes assistant events by request_id (one per content block), main session only. */
export function summarizeStream(events: readonly StreamEvent[]): { readonly usage: UsageSummary; readonly toolCalls: ToolCallRecord[] } {
  const seenRequests = new Set<string>();
  const mainModels = new Set<string>();
  const subModels = new Set<string>();
  let totalInput = 0;
  let mainRequests = 0;
  const contextByEventIndex = new Map<number, number | null>();

  const calls = new Map<string, { record: Omit<ToolCallRecord, "result" | "isError" | "resolvedAt" | "beforeFirstPlanWritten">; result?: string; isError?: boolean; resolvedAt?: number }>();
  const guideStates: { state: string; sessionId: string | null; toolUseId: string }[] = [];
  let firstPlanWrittenToolUseId: string | null = null;
  let firstPlanWrittenResolvedAt: number | null = null;
  const planResultIndexes: number[] = [];
  let resultEvent: StreamEvent | null = null;
  let initEvent: StreamEvent | null = null;

  events.forEach((ev, idx) => {
    if (ev.type === "system" && ev.subtype === "init") initEvent = ev;
    if (ev.type === "result") resultEvent = ev;
    if (ev.type === "assistant" && ev.message) {
      const main = ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;
      if (typeof ev.message.model === "string") (main ? mainModels : subModels).add(ev.message.model);
      const rid = typeof ev.request_id === "string" ? ev.request_id : `idx-${idx}`;
      const ctx = usageContext(ev.message.usage);
      if (main && !seenRequests.has(rid)) {
        seenRequests.add(rid);
        mainRequests++;
        if (ctx !== null) totalInput += ctx;
      }
      if (main) contextByEventIndex.set(idx, ctx);
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          calls.set(b.id, { record: { toolUseId: b.id, name: b.name, input: b.input, requestId: typeof ev.request_id === "string" ? ev.request_id : null, parentToolUseId: main ? null : (ev.parent_tool_use_id as string), issuedAt: idx } });
          if (GUIDE_TOOL.test(b.name) && main && firstPlanWrittenToolUseId === null) {
            const input = b.input as { report?: { completedAction?: string } } | undefined;
            if (input?.report?.completedAction === "plan_written") firstPlanWrittenToolUseId = b.id;
          }
        }
      }
    }
    if (ev.type === "user" && ev.message) {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const entry = calls.get(b.tool_use_id);
        const text = toolResultText(b);
        if (entry) {
          entry.result = text;
          entry.isError = b.is_error === true;
          entry.resolvedAt = idx;
          if (GUIDE_TOOL.test(entry.record.name) && entry.record.parentToolUseId === null) {
            const state = /\*\*State:\*\*\s*([A-Z_]+)/.exec(text)?.[1] ?? null;
            const sid = /\*\*Session:\*\*\s*([0-9a-f-]{36})/i.exec(text)?.[1] ?? null;
            if (state) {
              guideStates.push({ state, sessionId: sid, toolUseId: b.tool_use_id });
              if (state === "PLAN") planResultIndexes.push(idx);
            }
          }
          if (b.tool_use_id === firstPlanWrittenToolUseId) firstPlanWrittenResolvedAt = idx;
        }
      }
    }
  });

  // The checkpoint is a specific request: the first main-session assistant event after the PLAN result, and the
  // main-session assistant event that issued the first plan_written call. A request without usage yields null;
  // no other request's usage is ever substituted.
  const nextMainContextAfter = (idx: number): number | null => {
    for (let i = idx + 1; i < events.length; i++) {
      if (contextByEventIndex.has(i)) return contextByEventIndex.get(i) ?? null;
    }
    return null;
  };
  const planEntries = planResultIndexes.map(nextMainContextAfter);
  const planWrittenIssuedAt = firstPlanWrittenToolUseId === null ? null : (calls.get(firstPlanWrittenToolUseId)?.record.issuedAt ?? null);

  const toolCalls: ToolCallRecord[] = [...calls.values()].map((e) => ({
    ...e.record,
    result: e.result ?? "",
    isError: e.isError ?? false,
    resolvedAt: e.resolvedAt ?? null,
    beforeFirstPlanWritten: firstPlanWrittenResolvedAt === null ? true : e.record.issuedAt < (calls.get(firstPlanWrittenToolUseId!)?.record.issuedAt ?? Infinity),
  }));

  return {
    usage: {
      planEntryContext: planEntries[0] ?? null,
      planEntries,
      beforePlanWrittenContext: firstPlanWrittenResolvedAt === null || planWrittenIssuedAt === null ? null : (contextByEventIndex.get(planWrittenIssuedAt) ?? null),
      totalInputTokens: totalInput,
      mainRequests,
      mainModels: [...mainModels].sort(),
      subagentModels: [...subModels].sort(),
      guideStates,
      guideSessionId: guideStates.find((g) => g.sessionId)?.sessionId ?? null,
      firstPlanWrittenToolUseId,
      resultEvent,
      initEvent,
    },
    toolCalls,
  };
}

// --- validity ---------------------------------------------------------------

/** The one ISS-906 sentence, matched by its stable head. */
export const STALE_NOTE_HEAD = "Server binary is stale";

export type InvalidReason =
  | "no-fingerprint"
  | "server-fingerprint"
  | "stale-note"
  | "model-drift"
  | "build-drift"
  | "config-drift"
  | "input-drift"
  | "mcp-servers"
  | "stream-corrupt"
  | "interrupted";

export interface ValidityInputs {
  readonly stateBinaryFingerprintSha256: string | null | undefined;
  readonly builtMcpSha256: string;
  readonly toolResults: readonly string[];
  readonly mainModels: readonly string[];
  readonly pinnedModel: string;
  /** The preflight build manifest's dist hashes; before and after must both equal it, key sets included. */
  readonly distHashesExpected: Record<string, string>;
  readonly distHashesBefore: Record<string, string>;
  readonly distHashesAfter: Record<string, string>;
  /** The experiment's configuration fingerprint; before and after must both equal it. */
  readonly configHashExpected: string;
  readonly configHashBefore: string;
  readonly configHashAfter: string;
  readonly streamCorrupt: boolean;
  readonly initMcpServers: readonly { readonly name?: string; readonly status?: string }[] | null;
  readonly interrupted: boolean;
  /** ISS-1274: INPUT_PATHS labels that drifted from preflight under the attempt and reach the cell (or could not be hashed). */
  readonly inputDriftInvalidating: readonly string[];
}

export function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, idx) => k === kb[idx] && a[k] === b[k]);
}

export function validity(i: ValidityInputs): { readonly valid: boolean; readonly reasons: InvalidReason[] } {
  const reasons: InvalidReason[] = [];
  if (i.interrupted) reasons.push("interrupted");
  if (!i.stateBinaryFingerprintSha256) reasons.push("no-fingerprint");
  else if (i.stateBinaryFingerprintSha256 !== i.builtMcpSha256) reasons.push("server-fingerprint");
  if (i.toolResults.some((t) => t.includes(STALE_NOTE_HEAD))) reasons.push("stale-note");
  if (i.mainModels.length !== 1 || i.mainModels[0] !== i.pinnedModel) reasons.push("model-drift");
  if (!sameHashes(i.distHashesExpected, i.distHashesBefore) || !sameHashes(i.distHashesExpected, i.distHashesAfter)) reasons.push("build-drift");
  if (i.configHashBefore !== i.configHashExpected || i.configHashAfter !== i.configHashExpected) reasons.push("config-drift");
  if (i.inputDriftInvalidating.length > 0) reasons.push("input-drift");
  const only = i.initMcpServers?.length === 1 ? i.initMcpServers[0] : undefined;
  if (!only || only.name !== "storybloq" || only.status !== "connected") reasons.push("mcp-servers");
  if (i.streamCorrupt) reasons.push("stream-corrupt");
  return { valid: reasons.length === 0, reasons };
}

// --- completion --------------------------------------------------------------

export type CompletionStatus = "completed" | "completed-no-commit" | "incomplete";

export interface CompletionInputs {
  readonly stateJson: { state?: string; status?: string; terminationReason?: string; completedTickets?: readonly { id?: string; displayId?: string }[] } | null;
  readonly ticketId: string;
  readonly ticketStatusOnDisk: string | null;
  readonly handoverWritten: boolean;
  readonly headMoved: boolean;
}

export function completion(i: CompletionInputs): { readonly status: CompletionStatus; readonly reason: string } {
  const s = i.stateJson;
  if (!s) return { status: "incomplete", reason: "no state.json for the tracked session" };
  if (s.state !== "SESSION_END") return { status: "incomplete", reason: `state.json.state is ${s.state ?? "absent"}, not SESSION_END` };
  if (s.status !== "completed" || s.terminationReason !== "normal") return { status: "incomplete", reason: `status ${s.status ?? "absent"} / terminationReason ${s.terminationReason ?? "absent"}` };
  const done = (s.completedTickets ?? []).some((t) => t.id === i.ticketId || t.displayId === i.ticketId);
  if (!done) return { status: "incomplete", reason: `${i.ticketId} not in completedTickets` };
  if (i.ticketStatusOnDisk !== "complete") return { status: "incomplete", reason: `ticket file status is ${i.ticketStatusOnDisk ?? "absent"}` };
  if (!i.handoverWritten) return { status: "incomplete", reason: "no handover written by the session" };
  if (!i.headMoved) return { status: "completed-no-commit", reason: "session ended normally but HEAD did not move" };
  return { status: "completed", reason: "SESSION_END, completed, normal, ticket complete, handover present, HEAD moved" };
}

// --- sanitisation and publication -------------------------------------------

export interface SanitizeContext {
  readonly workdir: string;
  readonly home: string;
  readonly user: string;
  /** The storybloq package checkout, whose absolute path is itself identifying. */
  readonly pkgRoot?: string;
  /** The fixture's own synthetic credentials, which must survive sanitisation so the scorer can see them. */
  readonly allowlist?: readonly string[];
}

export interface Substitution {
  readonly pattern: string;
  readonly replacement: string;
  readonly count: number;
}

export function sanitize(text: string, ctx: SanitizeContext): { readonly text: string; readonly substitutions: Substitution[] } {
  const subs: Substitution[] = [];
  let out = text;
  const allowed = new Set(ctx.allowlist ?? []);
  /**
   * Replaces exactly the spans a detector found, and nothing else. Detection runs on a decoded copy
   * (so `\/`, `\uXXXX` in any hex case, and surrogate pairs are all seen through), each match maps
   * back to the source bytes it came from, and the splice runs right to left. Replacing SPANS rather
   * than candidate strings is what stops one harmless match from erasing bytes inside another: a
   * span carrying a credential is skipped, and stays intact for publicationCheck to refuse.
   */
  const replaceSpans = (find: (decoded: string) => readonly { readonly start: number; readonly end: number; readonly value: string }[], token: string, label: string): number => {
    const dec = decodeForSpans(out);
    // Credentials are located across the WHOLE text, not inside each candidate: `Bearer /tmp/secret`
    // is one credential match that starts outside the path it swallows, so judging the path alone
    // would erase the secret's only alarm. Any overlap at all, partial included, protects the span.
    const guarded = credentialSpans(dec.text, allowed);
    const found = [...find(dec.text)]
      .filter((r) => !guarded.some((g) => r.start < g.end && g.start < r.end))
      .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const kept: { start: number; end: number }[] = [];
    for (const r of found) if (r.start >= (kept[kept.length - 1]?.end ?? -1)) kept.push({ start: r.start, end: r.end });
    for (let i = kept.length - 1; i >= 0; i--) {
      const r = kept[i]!;
      const from = dec.spans[r.start]!.start;
      const to = dec.spans[r.end - 1]!.end;
      out = `${out.slice(0, from)}${token}${out.slice(to)}`;
    }
    if (kept.length > 0) subs.push({ pattern: label, replacement: token, count: kept.length });
    return kept.length;
  };
  /** Every match of a plain matcher, as spans in the decoded text. */
  const matchSpans = (re: RegExp) => (decoded: string): { start: number; end: number; value: string }[] =>
    [...decoded.matchAll(new RegExp(re.source, re.flags))].map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
  /** Every occurrence of a root or its macOS /private twin, longest form first so neither eats the other. */
  const rootSpans = (root: string) => (decoded: string): { start: number; end: number; value: string }[] => {
    const twin = root.startsWith("/private/") ? root.slice("/private".length) : `/private${root}`;
    const hits: { start: number; end: number; value: string }[] = [];
    for (const form of [root, twin].sort((a, b) => b.length - a.length)) {
      for (let i = decoded.indexOf(form); i !== -1; i = decoded.indexOf(form, i + 1)) hits.push({ start: i, end: i + form.length, value: form });
    }
    return hits;
  };
  // Order matters: the workdir may live under the home directory.
  replaceSpans(rootSpans(ctx.workdir), "<WORKDIR>", "workdir");
  replaceSpans(matchSpans(/\/tmp\/cc-socks\/[^\s"']+/g), "<SOCK>", "cc-socks");
  if (ctx.pkgRoot) replaceSpans(rootSpans(ctx.pkgRoot), "<PKG>", "pkg");
  replaceSpans(rootSpans(ctx.home), "<HOME>", "home");
  // An address is identity, so it is substituted here, before <USER> can split one in half. Every
  // OTHER credential pattern is deliberately left for publicationCheck to REFUSE: a real secret in a
  // benchmark artefact is a surprise that must stop the pipeline, not something to quietly rewrite.
  const emailPattern = CREDENTIAL_PATTERNS.find((p) => p.label === "email");
  if (emailPattern) {
    replaceSpans((decoded) => [...decoded.matchAll(new RegExp(emailPattern.re.source, emailPattern.re.flags))]
      .filter((m) => !allowed.has(m[0]))
      .map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] })), "<EMAIL>", "email");
  }
  // Through the same guard as everything else: replacing a bare username inside `Bearer someone@host`
  // would break the credential match and publish the artefact clean.
  if (ctx.user.length >= 3) replaceSpans(matchSpans(new RegExp(`(?<![A-Za-z0-9])${ctx.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g")), "<USER>", "user");
  // Whatever absolute path is left is one no root could predict: a scratch file the session invented,
  // or another machine path. Found with the publication check's own detector, so the two agree by
  // construction. Repeated because replacing a root can expose a shorter path around it; it settles
  // in one or two rounds and the bound only stops a pathological input from looping.
  for (let round = 0; round < 4; round++) {
    const n = replaceSpans((decoded) => absolutePathMatches(decoded)
      .filter((m) => !isPublicPath(m.value))
      .map((m) => ({ start: m.index, end: m.index + m.length, value: m.value })), "<ABS>", "absolute-path");
    if (n === 0) break;
  }
  return { text: out, substitutions: subs };
}

interface DecodedText {
  readonly text: string;
  /** One entry per decoded UTF-16 code unit: the source span it was written as. */
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = { "\\": "\\", "/": "/", '"': '"', b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Decodes JSON string escapes, keeping every decoded character's source span. Every escape form is
 * decoded, not only the slash ones: an escaped QUOTE has to become a real quote here, or the quoted-path
 * detector would read the closing `\"` as part of the path and a replacement would delete its backslash,
 * leaving evidence.jsonl unparseable. `\\` is consumed as one unit so it cannot be misread as escaping
 * the quote that follows it.
 */
function decodeWithMap(src: string): DecodedText {
  const chars: string[] = [];
  const spans: { start: number; end: number }[] = [];
  let i = 0;
  while (i < src.length) {
    const next = src[i + 1];
    if (src[i] === "\\" && next === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      chars.push(String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)));
      spans.push({ start: i, end: i + 6 }); i += 6; continue;
    }
    if (src[i] === "\\" && next !== undefined && next in SHORT_ESCAPES) {
      chars.push(SHORT_ESCAPES[next]!); spans.push({ start: i, end: i + 2 }); i += 2; continue;
    }
    chars.push(src[i]!); spans.push({ start: i, end: i + 1 }); i += 1;
  }
  return { text: chars.join(""), spans };
}

/** Where the real credentials are (never an address): spans that must reach publicationCheck intact. */
function credentialSpans(decoded: string, allowed: ReadonlySet<string>): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const p of CREDENTIAL_PATTERNS) {
    if (p.identity) continue;
    for (const m of decoded.matchAll(new RegExp(p.re.source, p.re.flags))) {
      // Same line as the check: a literal too short to be a credential must not guard the text around it.
      if (meetsCredentialFloor(p, m) && !allowed.has(m[0])) out.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** JSON's escapes only mean anything inside JSON. In plain text a backslash is a filename character. */
function parsesJson(t: string): boolean {
  try { JSON.parse(t); return true; } catch { return false; }
}

/** Every code unit maps to itself, for text whose backslashes are filename characters rather than escapes. */
function identityDecode(src: string, offset: number): DecodedText {
  const chars: string[] = [];
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < src.length; i++) { chars.push(src[i]!); spans.push({ start: offset + i, end: offset + i + 1 }); }
  return { text: chars.join(""), spans };
}

/**
 * decodeWithMap applied only where JSON escapes mean anything: a JSON document decoded whole, a JSONL file
 * decoded line by line (a line that does not parse keeps its bytes), and plain text left alone. Decoding
 * unconditionally reads a literal backslash-n in a plain-text filename as a line break, which hid the rest of
 * the path from the quoted matcher: the sanitiser then replaced only the rooted head, and the identifying tail
 * published, because the check could no longer see a rooted path to refuse. ONE classification, used by the
 * sanitiser and by the publication check, so the two can never judge an artefact differently again.
 */
function decodeForSpans(src: string): DecodedText {
  if (parsesJson(src)) return decodeWithMap(src);
  const lines = src.split("\n");
  if (!lines.some((l) => l.trim() !== "" && parsesJson(l))) return identityDecode(src, 0);
  const chars: string[] = [];
  const spans: { start: number; end: number }[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const d = line.trim() !== "" && parsesJson(line) ? decodeWithMap(line) : identityDecode(line, 0);
    for (let k = 0; k < d.spans.length; k++) {
      chars.push(d.text[k]!);
      spans.push({ start: offset + d.spans[k]!.start, end: offset + d.spans[k]!.end });
    }
    offset += line.length;
    if (i < lines.length - 1) { chars.push("\n"); spans.push({ start: offset, end: offset + 1 }); offset += 1; }
  }
  return { text: chars.join(""), spans };
}

/** True when a document that parsed before still parses after: a replacement must never break evidence. */
export function jsonShapePreserved(before: string, after: string): boolean {
  const parses = (t: string): boolean => { try { JSON.parse(t); return true; } catch { return false; } };
  if (parses(before)) return parses(after);
  const lines = before.split("\n").filter((l) => l.trim());
  if (lines.length === 0 || !lines.every(parses)) return true;
  const outLines = after.split("\n").filter((l) => l.trim());
  return outLines.length === lines.length && outLines.every(parses);
}

/** True when a path identifies nothing about the machine, by the publication check's own list. */
function isPublicPath(p: string): boolean {
  return PUBLIC_ABSOLUTE_PREFIXES.some((prefix) => withinPrefix(posix.normalize(p), prefix));
}

/**
 * The line between a credential that exists and a literal somebody invented for a test.
 *
 * It has to exist because the fixture task IS a redaction task: T-2 asks the session to implement a redactor for
 * `Bearer ...` and `sk-...`, so every session writes credential-shaped literals of its own, and an allowlist
 * derived from the fixture's bytes can only ever cover the ones the fixture already contains. Two live captures
 * were disqualified by exactly this: `Bearer abc123` and `Bearer token` in one, `sk-abcdefgh12345` in the next,
 * each a variant of a fixture literal, none of them a secret, each costing a whole observation.
 *
 * 32 sits between two measured populations and touches neither. Invented: `Bearer abc` (10), `Bearer abc123` (13),
 * `sk-abcdefghijk` (14), `sk-abcdefgh12345` (16). Real: an npm token 36, a GitHub PAT 36 to 40, an OpenAI key 51,
 * `sk-ant-oat01-...` over 100, a JWT over 100. The unconditional net under it is the known-secret check, which
 * compares against the values this machine actually holds, by value and at any length.
 *
 * The rule is uniform on purpose. The first fix gated only `bearer`, the pattern that had been seen to fail, and
 * the very next capture died on `sk-key`, which is the same hole in a pattern nobody had watched yet.
 */
const CREDENTIAL_MIN_LENGTH = 32;

interface CredentialPattern {
  readonly label: string;
  readonly re: RegExp;
  /** Identity rather than a credential: the length floor never applies. */
  readonly identity?: true;
  /** The group holding the credential itself, when the match also spans a label, separator or prefix. */
  readonly valueGroup?: number;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { label: "sk-ant", re: /sk-ant-[A-Za-z0-9_-]+/g },
  { label: "sk-key", re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  // A variable NAME is not a secret, and a session writing about redaction will name one. Its assigned VALUE is.
  // Quotes are optional on both sides so the JSON form `{"ANTHROPIC_AUTH_TOKEN":"..."}` is read like the shell one.
  { label: "anthropic-env", re: /ANTHROPIC_[A-Z_]+["']?\s*[=:]\s*["']?([^\s"',}]+)/g, valueGroup: 1 },
  { label: "oauth", re: /oauth[A-Za-z0-9._~+/=-]*/gi },
  { label: "bearer", re: /Bearer\s+([A-Za-z0-9._~+/=-]+)/g, valueGroup: 1 },
  // Identity, not a credential: an address identifies a person at any length, so the floor never applies to it.
  { label: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, identity: true },
];

/**
 * The credential inside a match. The floor is a statement about the SECRET, so a long variable name or a
 * `Bearer ` prefix must not push a short placeholder over it: `ANTHROPIC_API_KEY=placeholder-token` is 35
 * characters of which 17 are the value, and refusing it would be the same false refusal this floor prevents.
 */
function credentialValue(p: CredentialPattern, m: RegExpMatchArray): string {
  return (p.valueGroup === undefined ? m[0] : m[p.valueGroup]) ?? m[0];
}

/** True when a match is long enough, where it counts, to be a credential that exists. */
function meetsCredentialFloor(p: CredentialPattern, m: RegExpMatchArray): boolean {
  return p.identity === true || credentialValue(p, m).length >= CREDENTIAL_MIN_LENGTH;
}

/**
 * The values this machine actually holds secret, read from the runner's own environment: any variable whose name
 * ends in TOKEN, KEY, SECRET or PASSWORD, long enough to be a credential rather than a flag. These are compared by
 * value, never by shape, are never allowlistable, and their sample is always a fixed string so a refusal cannot
 * print the thing it refused. This is what makes the shape patterns safe to tune.
 */
export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_VARIABLE_NAME.test(k)) out.add(v);
  }
  return [...out];
}

const SECRET_VARIABLE_NAME = /(TOKEN|KEY|SECRET|PASSWORD)$/;

/**
 * Length is not a safe way to decide a collected value is NOT a credential: a short password is still a
 * password. But a short value is also what a flag or an identifier looks like, and refusing every artefact that
 * contains the word `test` because `API_KEY=test` is exported would make every capture impossible. So nothing is
 * dropped: the ambiguous NAMES are reported, preflight refuses, and the operator decides. Values never leave here.
 */
export function ambiguousEnvironmentSecrets(env: NodeJS.ProcessEnv, floor = 20): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && v.length > 0 && v.length < floor && SECRET_VARIABLE_NAME.test(k))
    .map(([k]) => k)
    .sort();
}

/** Every credential-looking string the fixture itself contains, so a read of N-1 or the test file can be published. */
export function fixtureCredentialAllowlist(fixtureDir: string): string[] {
  const { files } = hashTree(fixtureDir);
  const found = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(fixtureDir, f), "utf-8");
    // Every representation the check will scan. A fixture matched in only one of them refuses in another: the
    // raw form spells a JSON assignment `NAME":"value`, the rebuilt form spells it `NAME=value`, and an escaped
    // credential inside an array exists in neither until its string value is decoded.
    for (const p of CREDENTIAL_PATTERNS) for (const one of credentialScanViews(text)) for (const m of one.match(p.re) ?? []) found.add(m);
  }
  return [...found].sort();
}

export interface PublicationVerdict {
  readonly ok: boolean;
  readonly blocked: readonly { readonly label: string; readonly sample: string }[];
  readonly fixtureDerived: readonly { readonly value: string; readonly count: number }[];
}

/** Absolute prefixes that identify nothing about the machine and appear in ordinary shell commands. */
export const PUBLIC_ABSOLUTE_PREFIXES = ["/dev/", "/usr/bin/", "/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"] as const;

const SANITIZED_TOKEN = /<(?:WORKDIR|HOME|PKG|SOCK|USER|ABS|EMAIL)>[^\s"'`)\]]*/g;
/** Any absolute filesystem path (two or more segments), independent of root name, Unicode segments included; JSON-escaped slashes are unescaped first. */
const ABSOLUTE_PATH = /(?<![\p{L}\p{N}_.:<>/\\-])\/(?:[\p{L}\p{N}_.@+~-]+\/)+[\p{L}\p{N}_.@+~-]*/gu;
/** file:// URLs carry a path too; percent-encoding is decoded before the check. */
const FILE_URL = /file:\/\/(\/[^\s"'`)\]<>]+)/g;
/** A quoted path may contain spaces, which the bare matcher stops at. */
const QUOTED_PATH = /["'`](\/[^"'`\n]*?)["'`]/g;
/**
 * Every absolute-path candidate with the span it occupies: bare paths, file URLs, and quoted paths
 * with spaces. A file URL reports its WHOLE span, because its path may be percent-encoded and only
 * the whole token can be replaced safely.
 */
export function absolutePathMatches(t: string): { readonly value: string; readonly index: number; readonly length: number }[] {
  const out: { value: string; index: number; length: number }[] = [];
  for (const m of t.matchAll(new RegExp(ABSOLUTE_PATH.source, ABSOLUTE_PATH.flags))) out.push({ value: m[0], index: m.index, length: m[0].length });
  for (const m of t.matchAll(new RegExp(FILE_URL.source, FILE_URL.flags))) {
    const raw = m[1] ?? ""; let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
    out.push({ value: decoded, index: m.index, length: m[0].length });
  }
  // A quoted path needs whitespace (else the bare matcher saw it) and a second segment: `/story auto T-2` is a command, not a path.
  for (const m of t.matchAll(new RegExp(QUOTED_PATH.source, QUOTED_PATH.flags))) {
    const q = m[1] ?? "";
    if (/\s/.test(q) && q.indexOf("/", 1) > 0) out.push({ value: q, index: m.index + 1, length: q.length });
  }
  return out;
}

/** The same candidates as values only, for callers that judge rather than replace. */
export function absolutePathCandidates(t: string): string[] {
  return absolutePathMatches(t).map((m) => m.value);
}

function withinPrefix(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(p);
}

/**
 * Every `key=value` an object in the document states, rebuilt from the PARSED form so an escaped key reads the
 * same as a bare one: `{"ANTHROPIC_AUTH_TO\u004bEN":"..."}` is the same assignment as `ANTHROPIC_AUTH_TOKEN=...`,
 * and decodedStrings alone hands the key and the value over separately, losing what joins them.
 */
export function decodedAssignments(text: string): string[] {
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out.push(`${k}=${val}`);
        else collect(val);
      }
    }
  };
  try { collect(JSON.parse(text)); return out; } catch { /* not one document */ }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { collect(JSON.parse(line)); } catch { /* plain line */ }
  }
  return out;
}

/**
 * Every representation of a document that a credential scan reads: the bytes as written, each decoded string
 * value, and each rebuilt `key=value`. Both consumers go through this one list. Three defects in this file came
 * from two readers disagreeing about how content is spelled, and the last of them made a fixture's OWN
 * credential unallowlistable, because the allowlist read one spelling and the check refused another.
 */
export function credentialScanViews(text: string): string[] {
  return [text, ...decodedStrings(text), ...decodedAssignments(text)];
}

/** Every string value inside a JSON document, or inside each JSON line of a JSONL document; empty for plain text. */
export function decodedStrings(text: string): string[] {
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") for (const [k, val] of Object.entries(v as Record<string, unknown>)) { out.push(k); collect(val); }
  };
  try { collect(JSON.parse(text)); return out; } catch { /* not one document */ }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { collect(JSON.parse(line)); } catch { /* plain line */ }
  }
  return out;
}

/**
 * Refuses when any credential-looking string survives that is not an exact fixture-derived allowlist entry, when
 * any value in `secrets` survives at all, or when any absolute path survives that is neither a sanitiser token nor
 * under an explicitly public prefix.
 * JSON and JSONL artefacts are scanned both as serialised text and as their decoded string values, so an escape
 * sequence cannot hide a credential. Paths are normalised before the boundary check, so `/bin/../etc/x` is
 * judged as `/etc/x`. Allowed prefixes are directory boundaries: `/x/dist` never admits `/x/dist-private`.
 */
export function publicationCheck(text: string, allowlist: readonly string[], opts: { readonly allowedAbsolutePrefixes?: readonly string[]; readonly secrets?: readonly string[] } = {}): PublicationVerdict {
  const allow = new Set(allowlist);
  const blocked: { label: string; sample: string }[] = [];
  const derived = new Map<string, number>();
  const prefixes = [...PUBLIC_ABSOLUTE_PREFIXES, ...(opts.allowedAbsolutePrefixes ?? [])];
  const secrets = (opts.secrets ?? []).filter((v) => v.length > 0);
  const decoded = decodedStrings(text);
  // A known secret is refused by value, before any shape rule, and it is the ONLY thing the verdict then carries.
  // A shape pattern matching the same value would put its first 24 characters into a sample, and from there into
  // a thrown error or a redaction ledger; an allowlisted one would land in fixtureDerived whole. Neither can
  // happen if the shape scans never run. Refusing is not allowlistable: `secrets` outranks `allowlist`.
  const hits = secrets.filter((v) => text.includes(v) || decoded.some((d) => d.includes(v)));
  if (hits.length > 0) return { ok: false, blocked: hits.map(() => ({ label: "known-secret", sample: "a value from the runner environment" })), fixtureDerived: [] };
  const scanCredentials = (t: string, countDerived = false): void => {
    for (const p of CREDENTIAL_PATTERNS) {
      for (const m of t.matchAll(new RegExp(p.re.source, p.re.flags))) {
        if (!meetsCredentialFloor(p, m)) continue;
        if (allow.has(m[0])) { if (countDerived) derived.set(m[0], (derived.get(m[0]) ?? 0) + 1); }
        else blocked.push({ label: p.label, sample: m[0].slice(0, 24) });
      }
    }
  };
  // The caller decodes before calling: the bytes as written are passed through decodeForSpans, which is the
  // sanitiser's own decoder and only decodes where JSON escapes mean anything, so both sides judge the same
  // text. A `\n` that is two characters in a JSON artefact is a real newline in the form the sanitiser saw, and
  // a quoted candidate cannot run past a line break on one side and stop at it on the other. Values from
  // decodedStrings arrive already decoded and are not decoded twice.
  const scanPaths = (t: string): void => {
    const stripped = t.replace(SANITIZED_TOKEN, "");
    for (const m of absolutePathCandidates(stripped)) {
      const norm = posix.normalize(m);
      if (!prefixes.some((p) => withinPrefix(norm, p))) blocked.push({ label: "absolute-path", sample: norm.slice(0, 48) });
    }
  };
  // Credentials: every representation, through the shared enumeration. Only the bytes as written account for
  // fixture-derived hits, so one occurrence is not counted again in each view.
  credentialScanViews(text).forEach((view, i) => scanCredentials(view, i === 0));
  // Paths: the bytes as written, decoded, and each decoded string value. A rebuilt assignment is skipped here
  // because its `=` is synthetic and every value in it is scanned on its own above.
  scanPaths(decodeForSpans(text).text);
  for (const s of decoded) scanPaths(s);
  return { ok: blocked.length === 0, blocked, fixtureDerived: [...derived].map(([value, count]) => ({ value, count })) };
}

// --- ledger snapshot diff ---------------------------------------------------

export interface LedgerChange {
  readonly path: string;
  readonly kind: "added" | "removed" | "changed";
  readonly fields?: Record<string, { readonly before: unknown; readonly after: unknown }>;
  /** The whole record for an added file (JSON when it parses, text otherwise); the scorer needs its content, not its name. */
  readonly content?: unknown;
}

/** `before` and `after` are copies of a `.story` directory, so the volatile entries are skipped at their root. */
export function diffLedger(before: string, after: string): LedgerChange[] {
  const skip = [...VOLATILE_STORY_ENTRIES];
  const b = new Map(hashTree(before, { skip }).files.map((f) => [f, readFileSync(join(before, f))]));
  const a = new Map(hashTree(after, { skip }).files.map((f) => [f, readFileSync(join(after, f))]));
  const asContent = (bytes: Buffer): unknown => { const t = bytes.toString("utf-8"); try { return JSON.parse(t); } catch { return t; } };
  const out: LedgerChange[] = [];
  for (const [f, bytes] of a) {
    const prev = b.get(f);
    if (!prev) out.push({ path: f, kind: "added", content: asContent(bytes) });
    else if (!prev.equals(bytes)) out.push({ path: f, kind: "changed", fields: jsonFieldDiff(prev.toString("utf-8"), bytes.toString("utf-8")) });
  }
  for (const [f, bytes] of b) if (!a.has(f)) out.push({ path: f, kind: "removed", content: asContent(bytes) });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

function jsonFieldDiff(before: string, after: string): Record<string, { before: unknown; after: unknown }> | undefined {
  try {
    const b = JSON.parse(before) as Record<string, unknown>;
    const a = JSON.parse(after) as Record<string, unknown>;
    const out: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out[k] = { before: b[k], after: a[k] };
    }
    return out;
  } catch {
    return undefined;
  }
}

// --- attempt layout and qualification ----------------------------------------

export const REPEATS = 3;
export const MAX_INVALID_RETRIES = 2;

export interface AttemptRecordLike {
  readonly validity: "valid" | "invalid";
  readonly experimentHash: string;
  readonly completed: boolean;
  /** Every artefact the scorer needs was published and still hashes to what the record lists. */
  readonly evidenceComplete: boolean;
  /** The cell the record was captured for; a record copied into another cell can never satisfy it. */
  readonly task?: string;
  readonly repeat?: number;
}

export type CellDecision =
  | { readonly kind: "satisfied"; readonly attempt: string; readonly evidenceComplete: boolean }
  | { readonly kind: "run"; readonly nextAttempt: number; readonly mismatched: readonly string[] }
  | { readonly kind: "exhausted"; readonly mismatched: readonly string[] };

/**
 * One valid observation satisfies a cell. Every allocated attempt directory of this experiment counts toward the
 * retry limit, including one whose record never persisted (a crash is still a paid attempt), and a record from a
 * foreign experiment counts for nothing but its number. Attempt numbers only grow.
 */
export function decideCell(attempts: readonly { readonly name: string; readonly record: AttemptRecordLike | null }[], experiment: string, cell: { readonly task: string; readonly repeat: number }): CellDecision {
  const numbered = attempts
    .map((a) => ({ ...a, n: Number(/attempt-(\d+)/.exec(a.name)?.[1] ?? "0") }))
    .sort((x, y) => x.n - y.n);
  const matches = (r: AttemptRecordLike): boolean => r.task === cell.task && r.repeat === cell.repeat;
  const mismatched = numbered.filter((a) => a.record && !matches(a.record)).map((a) => `${a.name} records ${a.record!.task ?? "?"}#${a.record!.repeat ?? "?"}`);
  for (const a of numbered) {
    if (a.record && matches(a.record) && a.record.completed && a.record.validity === "valid" && a.record.experimentHash === experiment) return { kind: "satisfied", attempt: a.name, evidenceComplete: a.record.evidenceComplete };
  }
  const counted = numbered.filter((a) => a.record === null || (a.record.experimentHash === experiment && matches(a.record))).length;
  if (counted > MAX_INVALID_RETRIES) return { kind: "exhausted", mismatched };
  const next = (numbered.at(-1)?.n ?? 0) + 1;
  return { kind: "run", nextAttempt: next, mismatched };
}

export function attemptDirName(n: number): string {
  return `attempt-${String(n).padStart(3, "0")}`;
}

export interface VerifiedRecord {
  readonly validity: "valid" | "invalid";
  readonly experimentHash: string;
  readonly completed: true;
  readonly evidenceComplete: boolean;
  readonly task: string;
  readonly repeat: number;
  readonly attempt: number;
  readonly arm: number;
  readonly completion: CompletionStatus;
  readonly completionReason: string;
  readonly requiredArtefacts: readonly string[];
  readonly invalidReasons: readonly string[];
  readonly wallMs: number;
  readonly [key: string]: unknown;
}

export interface AttemptVerification {
  /** null when record.json is absent, unreadable, off-schema, or does not hash as its manifest says. */
  readonly record: VerifiedRecord | null;
  /** True only when the record claims it AND every required artefact is listed in the manifest and still hashes as listed. */
  readonly evidenceComplete: boolean;
  readonly reason: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The one reader both the runner (resume) and the scorer (prepare, record, report) use. Nothing about an attempt
 * is trusted from record.json alone: the record must hash as artefacts.sha256.json lists, the manifest must be
 * well formed, and every artefact the record names as required must be present, listed and unchanged.
 */
export function verifyAttemptDir(dir: string): AttemptVerification {
  const recordPath = join(dir, "record.json");
  const hashesPath = join(dir, "artefacts.sha256.json");
  if (!existsSync(recordPath) || !existsSync(join(dir, "completed"))) return { record: null, evidenceComplete: false, reason: "no completed record" };
  if (!existsSync(hashesPath)) return { record: null, evidenceComplete: false, reason: "no artefact manifest" };
  let hashes: Record<string, string>;
  try {
    const parsed = JSON.parse(readFileSync(hashesPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed as Record<string, unknown>).every((h) => typeof h === "string" && HEX64.test(h))) return { record: null, evidenceComplete: false, reason: "artefact manifest off-schema" };
    hashes = parsed as Record<string, string>;
  } catch { return { record: null, evidenceComplete: false, reason: "artefact manifest unreadable" }; }
  const recordBytes = readFileSync(recordPath);
  if (hashes["record.json"] !== sha256(recordBytes)) return { record: null, evidenceComplete: false, reason: "record.json does not hash as listed" };
  let r: Record<string, unknown>;
  try { r = JSON.parse(recordBytes.toString("utf-8")) as Record<string, unknown>; } catch { return { record: null, evidenceComplete: false, reason: "record unreadable" }; }
  const schemaOk = (r.validity === "valid" || r.validity === "invalid") && typeof r.experimentHash === "string" && r.completed === true && typeof r.evidenceComplete === "boolean"
    && typeof r.task === "string" && typeof r.repeat === "number" && typeof r.attempt === "number" && typeof r.arm === "number" && typeof r.completion === "string"
    && typeof r.completionReason === "string" && Array.isArray(r.requiredArtefacts) && Array.isArray(r.invalidReasons) && typeof r.wallMs === "number";
  if (!schemaOk) return { record: null, evidenceComplete: false, reason: "record schema" };
  const record = r as unknown as VerifiedRecord;
  let evidenceComplete = record.evidenceComplete;
  let reason: string | null = evidenceComplete ? null : "record reports incomplete evidence";
  for (const f of record.requiredArtefacts) {
    if (!(f in hashes)) { evidenceComplete = false; reason = `required artefact ${f} not in manifest`; break; }
  }
  if (evidenceComplete) {
    for (const [f, h] of Object.entries(hashes)) {
      if (f === "record.json") continue;
      if (!existsSync(join(dir, f)) || sha256(readFileSync(join(dir, f))) !== h) { evidenceComplete = false; reason = `artefact ${f} missing or changed`; break; }
    }
  }
  return { record, evidenceComplete, reason };
}

export interface QualificationInputs {
  readonly cells: readonly { readonly task: string; readonly repeat: number; readonly satisfied: boolean; readonly evidenceComplete: boolean }[];
  readonly isolation: "fresh" | "shared";
  /** A validated owner exception (the runner resolves the id before capture), or null. */
  readonly ownerException: string | null;
}

/** The preregistered matrix: every task in TASKS, repeats 1..REPEATS. */
export function expectedCellKeys(): string[] {
  return TASKS.flatMap((task) => Array.from({ length: REPEATS }, (_, i) => `${task}#${i + 1}`));
}

/**
 * QUALIFYING needs exactly the preregistered cells, each with one valid observation whose evidence is
 * complete. Duplicate, unknown or out-of-range cells disqualify; the reason names every missing key.
 */
export function qualifies(i: QualificationInputs): { readonly qualifying: boolean; readonly shortCells: string[]; readonly unpublishedCells: string[]; readonly reason: string } {
  const expected = expectedCellKeys();
  const keys = i.cells.map((c) => `${c.task}#${c.repeat}`);
  const seen = new Set<string>();
  const duplicates = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  const unknown = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !seen.has(k));
  const shortCells = [...missing, ...i.cells.filter((c) => !c.satisfied).map((c) => `${c.task}#${c.repeat}`)].filter((k, idx, arr) => arr.indexOf(k) === idx);
  const unpublishedCells = i.cells.filter((c) => c.satisfied && !c.evidenceComplete).map((c) => `${c.task}#${c.repeat}`);
  if (duplicates.length > 0) return { qualifying: false, shortCells, unpublishedCells, reason: `duplicate cells: ${duplicates.join(", ")}` };
  if (unknown.length > 0) return { qualifying: false, shortCells, unpublishedCells, reason: `unknown cells: ${unknown.join(", ")}` };
  if (missing.length > 0) return { qualifying: false, shortCells, unpublishedCells, reason: `missing cells: ${missing.join(", ")}` };
  if (shortCells.length > 0) return { qualifying: false, shortCells, unpublishedCells, reason: `${shortCells.length} cell(s) without a valid observation: ${shortCells.join(", ")}` };
  if (unpublishedCells.length > 0) return { qualifying: false, shortCells, unpublishedCells, reason: `${unpublishedCells.length} observation(s) with incomplete published evidence: ${unpublishedCells.join(", ")}` };
  if (i.isolation === "shared" && !i.ownerException) return { qualifying: false, shortCells, unpublishedCells, reason: "shared isolation without a recorded owner exception" };
  return { qualifying: true, shortCells, unpublishedCells, reason: "every cell has one valid observation with complete evidence" };
}

// --- skill payload inventory ------------------------------------------------

export const SKILL_MARKER_FILE = ".storybloq-version";

/** Installed skill payload equals the source payload except for exactly the documented marker. */
export function skillPayloadDiff(installedDir: string, sourceDir: string): { readonly ok: boolean; readonly extra: string[]; readonly missing: string[]; readonly changed: string[]; readonly marker: string | null } {
  const inst = hashTree(installedDir);
  const src = hashTree(sourceDir);
  const instSet = new Set(inst.files);
  const srcSet = new Set(src.files);
  const extra = [...inst.files.filter((f) => !srcSet.has(f) && f !== SKILL_MARKER_FILE), ...inst.links.map((l) => `${l} (symlink)`), ...src.links.map((l) => `${l} (symlink in source)`)];
  const missing = src.files.filter((f) => !instSet.has(f));
  const changed = src.files.filter((f) => instSet.has(f) && !readFileSync(join(installedDir, f)).equals(readFileSync(join(sourceDir, f))));
  const markerPath = join(installedDir, SKILL_MARKER_FILE);
  const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf-8").trim() : null;
  return { ok: extra.length === 0 && missing.length === 0 && changed.length === 0, extra, missing, changed, marker };
}
