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
}

export interface Substitution {
  readonly pattern: string;
  readonly replacement: string;
  readonly count: number;
}

export function sanitize(text: string, ctx: SanitizeContext): { readonly text: string; readonly substitutions: Substitution[] } {
  const subs: Substitution[] = [];
  let out = text;
  const apply = (pattern: string | RegExp, replacement: string, label: string): void => {
    const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : pattern;
    const count = (out.match(re) ?? []).length;
    if (count > 0) {
      out = out.replace(re, replacement);
      subs.push({ pattern: label, replacement, count });
    }
  };
  // Order matters: the workdir may live under the home directory.
  apply(ctx.workdir, "<WORKDIR>", "workdir");
  apply(/\/tmp\/cc-socks\/[^\s"']+/g, "<SOCK>", "cc-socks");
  if (ctx.pkgRoot) apply(ctx.pkgRoot, "<PKG>", "pkg");
  apply(ctx.home, "<HOME>", "home");
  if (ctx.user.length >= 3) apply(new RegExp(`(?<![A-Za-z0-9])${ctx.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"), "<USER>", "user");
  return { text: out, substitutions: subs };
}

const CREDENTIAL_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "sk-ant", re: /sk-ant-[A-Za-z0-9_-]+/g },
  { label: "sk-key", re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { label: "anthropic-env", re: /ANTHROPIC_[A-Z_]+/g },
  { label: "oauth", re: /oauth[A-Za-z0-9_-]*/gi },
  { label: "bearer", re: /Bearer\s+[A-Za-z0-9._~+/=-]+/g },
  { label: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

/** Every credential-looking string the fixture itself contains, so a read of N-1 or the test file can be published. */
export function fixtureCredentialAllowlist(fixtureDir: string): string[] {
  const { files } = hashTree(fixtureDir);
  const found = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(fixtureDir, f), "utf-8");
    for (const p of CREDENTIAL_PATTERNS) for (const m of text.match(p.re) ?? []) found.add(m);
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

const SANITIZED_TOKEN = /<(?:WORKDIR|HOME|PKG|SOCK|USER)>[^\s"'`)\]]*/g;
/** Any absolute filesystem path (two or more segments), independent of root name, Unicode segments included; JSON-escaped slashes are unescaped first. */
const ABSOLUTE_PATH = /(?<![\p{L}\p{N}_.:<>/\\-])\/(?:[\p{L}\p{N}_.@+~-]+\/)+[\p{L}\p{N}_.@+~-]*/gu;
/** file:// URLs carry a path too; percent-encoding is decoded before the check. */
const FILE_URL = /file:\/\/(\/[^\s"'`)\]<>]+)/g;
/** A quoted path may contain spaces, which the bare matcher stops at. */
const QUOTED_PATH = /["'`](\/[^"'`\n]*?)["'`]/g;

/** Every absolute-path candidate in a text: bare paths, file URLs, and quoted paths with spaces. */
export function absolutePathCandidates(t: string): string[] {
  const out: string[] = [];
  for (const m of t.match(ABSOLUTE_PATH) ?? []) out.push(m);
  for (const m of t.matchAll(FILE_URL)) { const raw = m[1] ?? ""; let decoded = raw; try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ } out.push(decoded); }
  // A quoted path needs whitespace (else the bare matcher saw it) and a second segment: `/story auto T-2` is a command, not a path.
  for (const m of t.matchAll(QUOTED_PATH)) { const q = m[1] ?? ""; if (/\s/.test(q) && q.indexOf("/", 1) > 0) out.push(q); }
  return out;
}

function withinPrefix(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(p);
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
 * Refuses when any credential-looking string survives that is not an exact fixture-derived allowlist entry, or
 * when any absolute path survives that is neither a sanitiser token nor under an explicitly public prefix.
 * JSON and JSONL artefacts are scanned both as serialised text and as their decoded string values, so an escape
 * sequence cannot hide a credential. Paths are normalised before the boundary check, so `/bin/../etc/x` is
 * judged as `/etc/x`. Allowed prefixes are directory boundaries: `/x/dist` never admits `/x/dist-private`.
 */
export function publicationCheck(text: string, allowlist: readonly string[], opts: { readonly allowedAbsolutePrefixes?: readonly string[] } = {}): PublicationVerdict {
  const allow = new Set(allowlist);
  const blocked: { label: string; sample: string }[] = [];
  const derived = new Map<string, number>();
  const prefixes = [...PUBLIC_ABSOLUTE_PREFIXES, ...(opts.allowedAbsolutePrefixes ?? [])];
  const scan = (t: string, countDerived: boolean): void => {
    for (const p of CREDENTIAL_PATTERNS) {
      for (const m of t.match(p.re) ?? []) {
        if (allow.has(m)) { if (countDerived) derived.set(m, (derived.get(m) ?? 0) + 1); }
        else blocked.push({ label: p.label, sample: m.slice(0, 24) });
      }
    }
    const stripped = t.replace(/\\\//g, "/").replace(SANITIZED_TOKEN, "");
    for (const m of absolutePathCandidates(stripped)) {
      const norm = posix.normalize(m);
      if (!prefixes.some((p) => withinPrefix(norm, p))) blocked.push({ label: "absolute-path", sample: norm.slice(0, 48) });
    }
  };
  scan(text, true);
  for (const s of decodedStrings(text)) scan(s, false);
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
