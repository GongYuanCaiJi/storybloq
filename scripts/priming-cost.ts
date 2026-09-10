/**
 * T-497: replay the guard-free /story invocation (Step 0.5 through the
 * Ready-to-Work table, per ~/.claude/skills/story/SKILL.md) against a frozen
 * fixture project, measuring real per-step byte counts and call counts.
 *
 * Two modes:
 *   --emit-json <fixtureRoot>   One measurement pass. Prints exactly one JSON
 *                               object to stdout, nothing else on stdout.
 *   --live [root]               Observational report against a real project
 *                               (default: cwd). Unfrozen clock, real git log.
 *
 * Every mutant-killing assertion in the test suite is re-derived from the raw
 * transport-capture log (`rawLog` below), never trusted from this script's own
 * derived per-step fields alone -- a mutant that fakes its own summary while
 * the raw log shows different real activity is still caught.
 */
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../src/mcp/tools.js";

const execFileAsync = promisify(execFileCb);

// --- byte accounting -------------------------------------------------------

/** UTF-8 byte length, never UTF-16 `.length` (T-497 m3). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// --- temp-root normalization (T-497 m4) -------------------------------------
//
// Two child-process runs against two different mkdtemp() copies of the fixture
// use two DIFFERENT root paths, which can differ in string length. Computing
// byte counts from the RAW captured content (which can embed that root path,
// directly or via a symlink-resolved realpath) makes the pinned byte counts
// flap between runs even when the semantic content is identical. Every string
// value is normalized -- on a COPY, before serialization and byte counting --
// so the numeric fields themselves are computed from already-normalized
// content, never patched after the fact. The raw (unnormalized) capture is
// kept only for `rawLog`, which the mutant tests read for structural
// assertions (tool names, call counts) that must reflect what was genuinely
// transmitted.

export const FIXTURE_ROOT_PLACEHOLDER = "<FIXTURE_ROOT>";

export interface Normalizer {
  (value: unknown): unknown;
}

/** Longest-match-first so a nested longer candidate never loses to a shorter prefix. */
export function buildNormalizer(root: string): Normalizer {
  const abs = resolve(root);
  const candidates = new Set<string>([abs]);
  if (existsSync(abs)) {
    try {
      candidates.add(realpathSync(abs));
    } catch {
      // best-effort; abs alone still covers the common case
    }
  }
  const sorted = [...candidates].sort((a, b) => b.length - a.length);

  function normalizeString(s: string): string {
    let out = s;
    for (const candidate of sorted) {
      if (candidate.length === 0) continue;
      out = out.split(candidate).join(FIXTURE_ROOT_PLACEHOLDER);
    }
    return out;
  }

  function normalizeValue(value: unknown): unknown {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = normalizeValue(v);
      }
      return result;
    }
    return value;
  }

  return normalizeValue;
}

/** Bytes of the normalized-then-serialized value. Route JSON-RPC message / sub-part-of-a-JSON-string byte counting through this. */
function measuredBytes(value: unknown, normalize: Normalizer): number {
  return byteLength(JSON.stringify(normalize(value)));
}

/**
 * Bytes of normalized RAW TEXT, with no JSON-string escaping overhead. Route
 * every direct-read or constructed-text step (RULES.md content, git log
 * text, the Continuation block, the Ready-to-Work table) through this, never
 * through `measuredBytes` -- that would count wrapping quotes and escaped
 * newlines that were never actually transmitted or read as such.
 */
function measuredTextBytes(text: string, normalize: Normalizer): number {
  return byteLength(normalize(text) as string);
}

// --- transport capture -------------------------------------------------------

export type TransportDirection = "client-to-server" | "server-to-client";

export interface CapturedMessage {
  readonly seq: number;
  readonly direction: TransportDirection;
  /** Raw, UNNORMALIZED JSON-RPC message exactly as sent. */
  readonly message: Record<string, unknown>;
}

interface CapturingTransports {
  readonly clientTransport: InMemoryTransport;
  readonly serverTransport: InMemoryTransport;
  readonly log: CapturedMessage[];
}

function createCapturingLinkedPair(): CapturingTransports {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const log: CapturedMessage[] = [];
  let seq = 0;

  function wrap(transport: InMemoryTransport, direction: TransportDirection): void {
    const originalSend = transport.send.bind(transport);
    transport.send = async (message: unknown, options?: unknown) => {
      log.push({ seq: seq++, direction, message: message as Record<string, unknown> });
      return (originalSend as (m: unknown, o?: unknown) => Promise<void>)(message, options);
    };
  }

  wrap(clientTransport, "client-to-server");
  wrap(serverTransport, "server-to-client");

  return { clientTransport, serverTransport, log };
}

/** Slices `log` to the entries appended since `since` (call is awaited, so no interleaving). */
function since(log: CapturedMessage[], mark: number): CapturedMessage[] {
  return log.slice(mark);
}

function findByDirection(
  entries: readonly CapturedMessage[],
  direction: TransportDirection,
): CapturedMessage | undefined {
  return entries.find((e) => e.direction === direction);
}

// --- step measurement --------------------------------------------------------

export interface ExchangeMeasurement {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
  readonly calls: number;
  readonly rawRequest: unknown;
  readonly rawResponse: unknown;
}

/** Extracts a JSON-RPC message's `id`, or undefined for a notification (which carries none). */
function messageId(message: unknown): unknown {
  return (message as { id?: unknown } | null)?.id;
}

function measureExchange(
  log: CapturedMessage[],
  mark: number,
  normalize: Normalizer,
): ExchangeMeasurement {
  const entries = since(log, mark);
  const req = findByDirection(entries, "client-to-server");
  if (!req) {
    throw new Error(`measureExchange: expected a request+response pair, got ${entries.length} entries`);
  }
  // Match the response to THIS request by JSON-RPC id, not merely "the first
  // server-to-client entry" -- a notification interleaved between them (no
  // id of its own) would otherwise be mistaken for, or mask, the real reply.
  const reqId = messageId(req.message);
  const res = entries.find((e) => e.direction === "server-to-client" && messageId(e.message) === reqId);
  if (!res) {
    throw new Error(`measureExchange: expected a request+response pair, got ${entries.length} entries`);
  }
  const requestBytes = measuredBytes(req.message, normalize);
  const responseBytes = measuredBytes(res.message, normalize);
  return {
    requestBytes,
    responseBytes,
    totalBytes: requestBytes + responseBytes,
    calls: 1,
    rawRequest: req.message,
    rawResponse: res.message,
  };
}

/**
 * Sums whatever transport activity the log genuinely captured in [start,
 * end), regardless of whether requests and responses paired up cleanly --
 * unlike measureExchange, this never throws. Used to recover a step's real
 * cost when it crashed partway through its own post-processing (a JSON.parse
 * on an already-captured response, for example): every entry's bytes count
 * toward the total (a dangling, unanswered request still cost real bytes),
 * while `calls` counts only genuinely completed request+response pairs,
 * matched by JSON-RPC id (not merely by alternating direction, which a
 * notification interleaved between a request and its reply would miscount).
 */
function measureLogRange(
  log: CapturedMessage[],
  start: number,
  end: number,
  normalize: Normalizer,
): { bytes: number; calls: number } {
  const entries = log.slice(start, end);
  let bytes = 0;
  let calls = 0;
  const pendingRequestIds = new Set<unknown>();
  for (const entry of entries) {
    bytes += measuredBytes(entry.message, normalize);
    const id = messageId(entry.message);
    if (entry.direction === "client-to-server") {
      if (id !== undefined) pendingRequestIds.add(id);
    } else if (entry.direction === "server-to-client") {
      if (id !== undefined && pendingRequestIds.has(id)) {
        calls += 1;
        pendingRequestIds.delete(id);
      }
    }
  }
  return { bytes, calls };
}

function responseText(rawResponse: unknown): string {
  const content = (rawResponse as { result?: { content?: Array<{ type?: string; text?: string }> } })
    .result?.content;
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("responseText: expected a single text content block");
  }
  return first.text;
}

// --- recommend response parsing ---------------------------------------------
//
// storybloq_recommend never returns a table or JSON here (format defaults to
// "md" -- confirmed by reading formatRecommendations's source). It returns a
// numbered Markdown list: "N. **id** (kind) -- title" then "   _reason_". This
// regex is a fixture-authoring constraint, not a general Markdown parser --
// fixture titles avoid *_|` to sidestep escapeMarkdownInline edge cases.

export interface RecommendRow {
  readonly id: string;
  readonly kind: "ticket" | "issue" | "action";
  readonly title: string;
  readonly reason: string;
}

const RECOMMEND_ROW_RE = /^(\d+)\.\s+\*\*(\S+)\*\*\s+\((ticket|issue|action)\)\s+--\s+(.+)$/;

export function parseRecommendMarkdown(text: string): RecommendRow[] {
  const lines = text.split("\n");
  const rows: RecommendRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = RECOMMEND_ROW_RE.exec(lines[i] ?? "");
    if (!match) continue;
    const reasonLine = lines[i + 1] ?? "";
    const reasonMatch = /^\s{3}_(.+)_$/.exec(reasonLine);
    rows.push({
      id: match[2]!,
      kind: match[3] as RecommendRow["kind"],
      title: match[4]!,
      reason: reasonMatch ? reasonMatch[1]! : "",
    });
  }
  return rows;
}

/**
 * Validates the ENTIRE response against formatRecommendations's exact
 * grammar (read from output-formatter.ts): `"# Recommendations"`, a blank
 * line, then for each candidate in rank order a numbered line, a `   _reason_`
 * line, and a blank line, optionally followed by one trailing
 * `"Showing N of M candidates."` line. A response with any unrecognized or
 * out-of-sequence line -- a skipped rank, a missing reason line, stray
 * trailing content -- is REJECTED wholesale (returns null) rather than
 * silently accepting whichever rows happened to parse; a partially-matching
 * response is exactly the shape a real client could misread as complete
 * while actually missing candidates (and their issue_get calls).
 */
function parseFullRecommendMarkdown(text: string): RecommendRow[] | null {
  const lines = text.split("\n");
  if (lines[0] !== "# Recommendations" || lines[1] !== "") return null;
  const rows: RecommendRow[] = [];
  let i = 2;
  let rank = 1;
  while (i < lines.length) {
    if (i === lines.length - 1 && /^Showing \d+ of \d+ candidates\.$/.test(lines[i] ?? "")) {
      return rows;
    }
    const rowRe = new RegExp(`^${rank}\\.\\s+\\*\\*(\\S+)\\*\\*\\s+\\((ticket|issue|action)\\)\\s+--\\s+(.+)$`);
    const rowMatch = rowRe.exec(lines[i] ?? "");
    if (!rowMatch) return null;
    const reasonMatch = /^\s{3}_(.+)_$/.exec(lines[i + 1] ?? "");
    if (!reasonMatch) return null;
    if (lines[i + 2] !== "") return null;
    rows.push({
      id: rowMatch[1]!,
      kind: rowMatch[2] as RecommendRow["kind"],
      title: rowMatch[3]!,
      reason: reasonMatch[1]!,
    });
    i += 3;
    rank++;
  }
  return rows;
}

/**
 * storybloq_recommend's only other possible md-format outputs (confirmed by
 * reading formatRecommendations's source): three fixed "no recommendations"
 * messages. A genuine empty result is one of these three strings, never a
 * failure; anything else -- including a response that matches the numbered
 * list shape only PARTIALLY -- is a response shape this harness does not
 * recognize at all as complete, a real, distinct outcome from "zero
 * candidates", and the one live mode must retain already-captured transport
 * cost for while marking dependent steps incomplete.
 */
const KNOWN_EMPTY_RECOMMEND_TEXTS = [
  "No recommendations yet -- this project needs tickets and phases. Run the /story setup flow to get started.",
  "No recommendations. Run storybloq status for federation overview.",
  "No recommendations -- all work is complete or blocked.",
];

export interface RecommendParseResult {
  readonly rows: RecommendRow[];
  readonly parseFailed: boolean;
  readonly reason?: string;
}

export function deriveRecommendRows(text: string): RecommendParseResult {
  const strict = parseFullRecommendMarkdown(text);
  if (strict !== null && strict.length > 0) return { rows: strict, parseFailed: false };
  if (KNOWN_EMPTY_RECOMMEND_TEXTS.some((known) => text.trim() === known)) {
    return { rows: [], parseFailed: false };
  }
  return {
    rows: [],
    parseFailed: true,
    reason: "recommend response matched neither the full numbered-list shape nor a known empty-state message",
  };
}

/**
 * The retained-on-parse-failure report: the step's own already-transmitted-
 * and-measured request/response bytes and call count are kept exactly as
 * captured (the exchange genuinely happened), never zeroed or discarded, even
 * though `rows` -- and therefore every downstream step that depends on rows
 * (Gate B's issue_get walk) -- comes back empty. Exported standalone so the
 * retention behaviour is unit-testable against a synthetic measurement,
 * independent of whether the real tool's output space can ever actually
 * produce an unparseable response.
 */
export function buildFailedRecommendReport(
  measurement: ExchangeMeasurement,
  reason: string | undefined,
): StepReport {
  return {
    bytes: measurement.totalBytes,
    calls: measurement.calls,
    includedInTotal: true,
    status: "incomplete",
    reason,
    issueGetCalls: 0,
    actionableIssueCount: 0,
    requestCarriesCountTen: (measurement.rawRequest as any)?.params?.arguments?.count === 10,
  };
}

// --- continuation-check parsing ----------------------------------------------
//
// SKILL.md: "an actionable heading -- a heading matching next/open/remaining/
// todo/blocked, case-insensitively... Take the section from that heading to
// the next heading of equal or higher level."

const ACTIONABLE_HEADING_RE = /^(#{1,6})\s+.*\b(next|open|remaining|todo|blocked)\b/i;
const HEADING_RE = /^(#{1,6})\s+/;
const ENTITY_ID_RE = /\b(T-\d+[a-z]?|ISS-\d+)\b/g;
const DATE_LINE_RE = /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/m;

export interface ContinuationSection {
  readonly heading: string;
  readonly content: string;
  readonly slug: string;
  /** The actionable keyword that matched (next/open/remaining/todo/blocked), lowercased. */
  readonly keyword: string;
}

export function findContinuationSection(handoverBody: string): ContinuationSection | null {
  const lines = handoverBody.split("\n");
  let startIdx = -1;
  let level = 0;
  let keyword = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = ACTIONABLE_HEADING_RE.exec(line);
    if (m) {
      startIdx = i;
      level = m[1]!.length;
      // "blocked" always wins as the reported keyword when it appears
      // anywhere in the heading, independent of which alternative the
      // greedy regex above happened to capture (a heading like "## Blocked
      // work remaining" contains both "blocked" and "remaining"; greedy
      // backtracking finds the rightmost candidate, which would otherwise
      // silently report "remaining" and let promotion proceed).
      keyword = /\bblocked\b/i.test(line) ? "blocked" : m[2]!.toLowerCase();
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i] ?? "");
    if (h && h[1]!.length <= level) {
      endIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(startIdx, endIdx);
  const dateMatch = DATE_LINE_RE.exec(handoverBody);
  const slug = dateMatch ? `handover dated ${dateMatch[1]}` : "the latest handover";
  return {
    heading: sectionLines[0] ?? "",
    content: sectionLines.join("\n").replace(/\n+$/, ""),
    slug,
    keyword,
  };
}

/** Ids in the order they first appear in the section text, deduplicated. */
export function extractEntityIds(sectionText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sectionText.matchAll(ENTITY_ID_RE)) {
    const id = m[0];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// --- Ready-to-Work table construction -----------------------------------------

export interface ContextLookupRow {
  readonly id: string;
  readonly context: string;
  readonly diagnostic: string;
}

/**
 * Context is sourced ONLY from the already-captured storybloq_status JSON
 * payload's per-item fields, per the pen's ruling (never re-fetch, never
 * substitute the recommend response's own `reason` field). The JSON payload
 * is aggregate-only (confirmed by reading formatStatus's JSON branch) -- no
 * per-ticket phase field, no per-issue severity field -- so every row falls
 * back to "n/a" plus a diagnostic line. This is the ruling's own anticipated
 * outcome for a corpus that doesn't carry the data, not a new gap.
 */
export function lookupContextColumn(rows: readonly RecommendRow[]): ContextLookupRow[] {
  return rows.map((row) => ({
    id: row.id,
    context: "n/a",
    diagnostic:
      row.kind === "ticket"
        ? `${row.id}: status payload carries no per-ticket phase field`
        : `${row.id}: status payload carries no per-issue severity field`,
  }));
}

export function renderReadyToWorkTable(
  rows: readonly RecommendRow[],
  contextById: ReadonlyMap<string, { context: string; diagnostic: string }>,
): string {
  const lines: string[] = [
    "## Ready to Work (ranking)",
    "| Item    | Type   | Title                            | Context        |",
    "|---------|--------|-----------------------------------|----------------|",
  ];
  const shown = rows.slice(0, 5);
  const diagnosticLines: string[] = [];
  for (const row of shown) {
    const entry = contextById.get(row.id);
    const context = entry?.context ?? "n/a";
    lines.push(`| ${row.id} | ${row.kind} | ${row.title} | ${context} |`);
    if (entry?.diagnostic) diagnosticLines.push(`- ${row.id}: ${entry.diagnostic}`);
  }
  if (rows.length > shown.length) {
    lines.push(`(+${rows.length - shown.length} more)`);
  }
  if (diagnosticLines.length > 0) {
    lines.push("", ...diagnosticLines);
  }
  return lines.join("\n");
}

// --- Gate B actionability -----------------------------------------------------
//
// SKILL.md: an issue counts only when status is open/inprogress AND no
// explicit blocker or owner-gated marker appears in impact/resolution. The
// real skill leaves this to the agent's judgement; this harness approximates
// it with an explicit, documented, fixture-matching heuristic rather than
// claiming to reproduce open-ended judgement.
const OWNER_GATE_MARKER_RE = /\b(blocked|blocker|owner-gated)\b/i;

export function issueClearsActionabilityBar(issue: {
  status: string;
  impact?: string | null;
  resolution?: string | null;
}): boolean {
  if (issue.status !== "open" && issue.status !== "inprogress") return false;
  const text = `${issue.impact ?? ""} ${issue.resolution ?? ""}`;
  return !OWNER_GATE_MARKER_RE.test(text);
}

export function ticketClearsActionabilityBar(ticket: {
  status: string;
  blocked: boolean;
}): boolean {
  if (ticket.status !== "open" && ticket.status !== "inprogress") return false;
  return !ticket.blocked;
}

// --- reconciliation fingerprint comparison (SKILL.md's guard/status cross-check) ---
//
// Per-session fingerprint: sessionId, surviving sourceDir, population, state,
// compactPending, leaseState, and normalized ownerTask (client + id). A
// mismatch on any field is a reconciliation failure, which triggers a second
// session_guard call before the reported verdict can be trusted.

export interface SessionFingerprint {
  readonly sessionId: string;
  readonly sourceDir: string;
  readonly population: unknown;
  readonly state: unknown;
  readonly compactPending: unknown;
  readonly leaseState: unknown;
  readonly ownerTaskClient: string | null;
  readonly ownerTaskId: string | null;
}

function normalizeOwnerTask(ownerTask: unknown): { client: string | null; id: string | null } {
  if (!ownerTask || typeof ownerTask !== "object") return { client: null, id: null };
  const o = ownerTask as Record<string, unknown>;
  return {
    client: typeof o.client === "string" ? o.client : null,
    id: typeof o.id === "string" ? o.id : null,
  };
}

/** One fingerprint per unique sessionId; first occurrence in iteration order survives (this harness's own deterministic dedupe convention for comparing two differently-shaped session lists). */
/**
 * SKILL.md:133's stated dedup rule (what the MODEL applies, in prose,
 * because the fallback path cannot read `session-guard.ts`'s own
 * ISS-914 collision/survivor system): activeSessions first, resumableSessions
 * second, ordered by sourceDir within each population, keep the first record
 * per full sessionId. `SessionVerdict.population` already carries this tag
 * natively on the guard side; the status side is tagged by the caller before
 * reaching here (see `stepReconciliation`), since `ActiveSessionSummary` has
 * no `population` field of its own -- it is purely positional (which array
 * it came from).
 */
function orderSessionsForDedupe(sessions: readonly unknown[]): unknown[] {
  const active: unknown[] = [];
  const resumable: unknown[] = [];
  const unpopulated: unknown[] = []; // defensive: no population tag at all -- kept last, stable order
  for (const raw of sessions) {
    const p = (raw as Record<string, unknown>)?.population;
    if (p === "activeSessions") active.push(raw);
    else if (p === "resumableSessions") resumable.push(raw);
    else unpopulated.push(raw);
  }
  const bySourceDir = (a: unknown, b: unknown): number => {
    const sa = String((a as Record<string, unknown>)?.sourceDir ?? "");
    const sb = String((b as Record<string, unknown>)?.sourceDir ?? "");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  active.sort(bySourceDir);
  resumable.sort(bySourceDir);
  return [...active, ...resumable, ...unpopulated];
}

export function buildFingerprints(sessions: readonly unknown[]): Map<string, SessionFingerprint> {
  const ordered = orderSessionsForDedupe(sessions);
  const out = new Map<string, SessionFingerprint>();
  for (const raw of ordered) {
    const s = raw as Record<string, unknown>;
    const id = s?.sessionId;
    if (typeof id !== "string" || out.has(id)) continue;
    const owner = normalizeOwnerTask(s?.ownerTask);
    out.set(id, {
      sessionId: id,
      sourceDir: typeof s?.sourceDir === "string" ? (s.sourceDir as string) : "",
      population: s?.population ?? null,
      state: s?.state ?? null,
      compactPending: s?.compactPending ?? null,
      leaseState: s?.leaseState ?? null,
      ownerTaskClient: owner.client,
      ownerTaskId: owner.id,
    });
  }
  return out;
}

export interface ReconciliationResult {
  readonly matched: boolean;
  readonly mismatchedIds: string[];
  readonly mismatchedFields: Record<string, string[]>;
}

const FINGERPRINT_FIELDS: (keyof SessionFingerprint)[] = [
  "sourceDir",
  "population",
  "state",
  "compactPending",
  "leaseState",
  "ownerTaskClient",
  "ownerTaskId",
];

export function reconcileFingerprints(
  guardSessions: readonly unknown[],
  statusSessions: readonly unknown[],
): ReconciliationResult {
  const guardFp = buildFingerprints(guardSessions);
  const statusFp = buildFingerprints(statusSessions);
  const allIds = new Set<string>([...guardFp.keys(), ...statusFp.keys()]);
  const mismatchedIds: string[] = [];
  const mismatchedFields: Record<string, string[]> = {};
  for (const id of allIds) {
    const a = guardFp.get(id);
    const b = statusFp.get(id);
    if (!a || !b) {
      mismatchedIds.push(id);
      mismatchedFields[id] = ["presence"];
      continue;
    }
    const fields = FINGERPRINT_FIELDS.filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
    if (fields.length > 0) {
      mismatchedIds.push(id);
      mismatchedFields[id] = fields;
    }
  }
  return { matched: mismatchedIds.length === 0, mismatchedIds, mismatchedFields };
}

// --- orchestrator gating (live-mode storybloq_node_list step) -----------------

/** Matches the codebase's own orchestrator gate (project-loader.ts, tools.ts, recommend.ts): `config.type === "orchestrator"`. */
export function isOrchestratorConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return c.type === "orchestrator";
}

// --- entity markdown parsing (storybloq_ticket_get / storybloq_issue_get) -----
//
// Neither tool accepts a `format` argument (confirmed: their inputSchema is
// {id, node} only) -- both always render Markdown via runMcpReadTool's
// default. formatTicket/formatIssue's shapes (confirmed by reading their
// source) are parsed directly rather than assumed to be JSON.

const STATUS_LINE_RE = /^Status:\s*(\S+)/m;

export function parseTicketMarkdown(text: string): { status: string; blocked: boolean } {
  const statusMatch = STATUS_LINE_RE.exec(text);
  const titleLine = text.split("\n")[0] ?? "";
  return {
    status: statusMatch ? statusMatch[1]! : "unknown",
    blocked: titleLine.includes("[BLOCKED]"),
  };
}

function extractFencedSection(text: string, heading: string): string {
  const re = new RegExp(`## ${heading}\\n\\n(\`{3,})\\n([\\s\\S]*?)\\n\\1`, "m");
  const m = re.exec(text);
  return m ? m[2]! : "";
}

export function parseIssueMarkdown(text: string): {
  status: string;
  impact: string;
  resolution: string;
} {
  const statusMatch = STATUS_LINE_RE.exec(text);
  return {
    status: statusMatch ? statusMatch[1]! : "unknown",
    impact: extractFencedSection(text, "Impact"),
    resolution: extractFencedSection(text, "Resolution"),
  };
}

// --- fixed step inventory (T-497 m1b) -----------------------------------------

export const STEP_NAMES = [
  "tool_discovery",
  "tool_discovery_reference",
  "session_guard",
  "reconciliation",
  "status",
  "recap",
  "handover_latest",
  "rules_md",
  "lesson_digest",
  "git_log",
  "recommend",
  "continuation_check",
  "context_column_lookup",
  "ready_to_work_table",
  "node_list",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

// --- fixture-mode git log (no .git directory in the fixture) -----------------

const FIXTURE_GIT_LOG_LINES = [
  "9f258c50 fix(bus): ISS-1162 bind park byEndpoint to thread participants",
  "eb8765ed docs(story): pen restart checkpoint 2",
  "71dead0a docs(story): pen handover addendum",
  "2df7d1f9 docs(story): ISS-1177 implementation shipped",
  "2dbfcfcb fix(app): ISS-1177 release background project window view trees",
  "49a8b2c2 docs(story): file the /story priming efficiency plan",
  "a1b2c3d4 fix(core): tighten earmark staleness threshold validation",
  "b2c3d4e5 feat(cli): add storybloq reconcile --ci flag",
  "c3d4e5f6 test(bus): cover redeliver refusal on unverified predecessor",
  "d4e5f6a7 chore(release): bump package version",
];
const FIXTURE_GIT_LOG_TEXT = FIXTURE_GIT_LOG_LINES.join("\n");

// --- report types --------------------------------------------------------------

export interface StepReport {
  readonly bytes: number;
  readonly calls: number;
  readonly includedInTotal: boolean;
  readonly [key: string]: unknown;
}

export interface PrimingCostReport {
  readonly mode: "fixture" | "live";
  readonly meta: {
    readonly measuredRoot: string;
    readonly generatedAt: string;
    // Live-mode-only observational metadata (T-497's 1a text: commit, dirty
    // state, session inventory, installed-skill hash, orchestrator flag).
    // Absent in fixture mode, whose meta stays a clean deterministic pair.
    readonly commit?: string | null;
    readonly dirty?: boolean | null;
    readonly sessionInventory?: { readonly count: number; readonly ids: readonly string[] };
    readonly installedSkillHash?: string | null;
    readonly orchestrator?: boolean;
  };
  readonly steps: Record<StepName, StepReport>;
  readonly totals: {
    readonly bytes: number;
    readonly calls: number;
    readonly status: "complete" | "observed_subtotal";
  };
  readonly rawLog: readonly CapturedMessage[];
}

// --- core replay (shared by fixture and live mode) ----------------------------

export interface ReplayContext {
  readonly root: string;
  readonly client: Client;
  readonly log: CapturedMessage[];
  readonly normalize: Normalizer;
  readonly gitLogMode: "fixture" | "live";
}

/**
 * Thrown by callTool whenever the exchange cannot be interpreted as a
 * successful {measurement, text} pair -- the underlying client call
 * rejected, or the response could not be read as text. `partialBytes` /
 * `partialCalls` carry whatever the transport genuinely captured for THIS
 * specific exchange (a full request+response pair still costs real bytes
 * even when the SDK surfaces it as an error), so a caller that catches this
 * can retain that cost instead of silently losing it.
 */
export class CallToolFailure extends Error {
  readonly partialBytes: number;
  readonly partialCalls: number;
  constructor(message: string, partialBytes: number, partialCalls: number) {
    super(message);
    this.name = "CallToolFailure";
    this.partialBytes = partialBytes;
    this.partialCalls = partialCalls;
  }
}

async function callTool(
  ctx: ReplayContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ measurement: ExchangeMeasurement; text: string }> {
  const mark = ctx.log.length;
  let callError: Error | null = null;
  try {
    await ctx.client.callTool({ name, arguments: args });
  } catch (err) {
    callError = err as Error;
  }

  let measurement: ExchangeMeasurement;
  try {
    measurement = measureExchange(ctx.log, mark, ctx.normalize);
  } catch {
    // No response was ever captured (a timeout, a dropped connection) -- but
    // a request was still genuinely SENT, and that costs real bytes even
    // though the exchange never completed. Recover just the request side;
    // this does not count as a completed call.
    const entries = since(ctx.log, mark);
    const req = findByDirection(entries, "client-to-server");
    const partialBytes = req ? measuredBytes(req.message, ctx.normalize) : 0;
    throw new CallToolFailure(callError ? callError.message : `${name}: no response captured`, partialBytes, 0);
  }

  if (callError) {
    // The transport genuinely captured a request+response pair even though
    // the client call itself rejected -- that traffic really happened and
    // its cost is real.
    throw new CallToolFailure(callError.message, measurement.totalBytes, measurement.calls);
  }

  let text: string;
  try {
    text = responseText(measurement.rawResponse);
  } catch (err) {
    throw new CallToolFailure((err as Error).message, measurement.totalBytes, measurement.calls);
  }

  return { measurement, text };
}

async function stepToolDiscovery(ctx: ReplayContext): Promise<{
  modeled: StepReport;
  reference: StepReport;
  realToolNames: string[];
}> {
  // Modeled: what a client's own discovery call looks like, names-only,
  // counted in the total. NOT a real transport call -- synthetic by design.
  const modeledRequest = { query: "storybloq", max_results: 100 };

  // Real reference call: actual client.listTools(), full payload including
  // schemas/descriptions (T-460 Leg B's subject) -- informational only.
  const mark = ctx.log.length;
  const result = await ctx.client.listTools();
  const referenceMeasurement = measureExchange(ctx.log, mark, ctx.normalize);
  const realToolNames = result.tools.map((t) => t.name).sort();

  const modeledResponse = { tools: realToolNames };
  const modeledRequestBytes = measuredBytes(modeledRequest, ctx.normalize);
  const modeledResponseBytes = measuredBytes(modeledResponse, ctx.normalize);

  return {
    modeled: {
      bytes: modeledRequestBytes + modeledResponseBytes,
      calls: 0,
      includedInTotal: true,
      modeled: true,
      modeledRequest: ctx.normalize(modeledRequest),
      modeledResponse: ctx.normalize(modeledResponse),
    },
    reference: {
      bytes: referenceMeasurement.totalBytes,
      calls: referenceMeasurement.calls,
      includedInTotal: false,
      modeled: false,
    },
    realToolNames,
  };
}

async function stepSessionGuard(ctx: ReplayContext): Promise<{ report: StepReport; verdict: any }> {
  const { measurement, text } = await callTool(ctx, "storybloq_session_guard", {});
  const verdict = JSON.parse(text);
  return {
    report: { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true },
    verdict,
  };
}

/** Tags each status-payload session with the population it came from -- `ActiveSessionSummary` carries no such field itself; it is purely positional (which array it was read from). */
function tagStatusSessionPopulations(statusPayload: any): unknown[] {
  const active = ((statusPayload.activeSessions ?? []) as Record<string, unknown>[]).map((s) => ({
    ...s,
    population: "activeSessions",
  }));
  const resumable = ((statusPayload.resumableSessions ?? []) as Record<string, unknown>[]).map((s) => ({
    ...s,
    population: "resumableSessions",
  }));
  return [...active, ...resumable];
}

export async function stepReconciliation(
  ctx: ReplayContext,
  guardVerdict: any,
  statusPayload: any,
): Promise<StepReport> {
  const guardSessions = (guardVerdict.sessions ?? []) as unknown[];
  const statusSessions = tagStatusSessionPopulations(statusPayload);
  const result = reconcileFingerprints(guardSessions, statusSessions);
  if (result.matched) {
    return { bytes: 0, calls: 0, includedInTotal: true, matched: true, verdict: "matched", mismatchedIds: [] };
  }
  // A fingerprint mismatch re-verifies with a second guard call before the
  // reconciliation outcome is trusted (SKILL.md's guard/status cross-check).
  // The retried verdict is actually re-compared, not discarded: only if it
  // STILL disagrees does reconciliation stay unresolved -- reported as
  // "unverifiable", the same vocabulary the real guard uses for "stop, do
  // not guess", not silently folded into a bare matched:false.
  const { measurement, text } = await callTool(ctx, "storybloq_session_guard", {});
  const retriedVerdict = JSON.parse(text);
  const retriedSessions = (retriedVerdict.sessions ?? []) as unknown[];
  const retryResult = reconcileFingerprints(retriedSessions, statusSessions);
  return {
    bytes: measurement.totalBytes,
    calls: measurement.calls,
    includedInTotal: true,
    matched: retryResult.matched,
    verdict: retryResult.matched ? "matched" : "unverifiable",
    mismatchedIds: retryResult.mismatchedIds,
    ...(retryResult.matched
      ? {}
      : { status: "incomplete", reason: "reconciliation mismatch persisted after a retried guard call" }),
  };
}

async function stepStatus(ctx: ReplayContext): Promise<{ report: StepReport; payload: any }> {
  const { measurement, text } = await callTool(ctx, "storybloq_status", { format: "json" });
  const payload = JSON.parse(text).data ?? JSON.parse(text);
  return {
    report: { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true },
    payload,
  };
}

async function stepRecap(ctx: ReplayContext): Promise<StepReport> {
  const { measurement } = await callTool(ctx, "storybloq_recap", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true };
}

const HANDOVER_SEPARATOR = "\n\n---\n\n";

async function stepHandoverLatest(ctx: ReplayContext): Promise<{ report: StepReport; bodies: string[] }> {
  const { measurement, text } = await callTool(ctx, "storybloq_handover_latest", { count: 3 });
  // handoverFilenames (and therefore these bodies) are ordered newest first.
  // A live project can legitimately have fewer than 3 handovers -- never
  // throw on an unexpected body count; report whatever actually came back.
  // (Known limitation: splitting on the literal separator is ambiguous if a
  // handover body itself happens to contain that exact 7-character string;
  // there is no structural per-file boundary in the tool's response to split
  // on instead.)
  const bodies = text.length > 0 ? text.split(HANDOVER_SEPARATOR) : [];
  const bodyContributions = bodies.map(
    (b) => measuredBytes(b, ctx.normalize) - 2, // JSON.stringify's own wrapping quotes
  );
  const sumBodies = bodyContributions.reduce((a, b) => a + b, 0);
  const overheadBytes = measurement.totalBytes - sumBodies;
  return {
    report: {
      bytes: measurement.totalBytes,
      calls: measurement.calls,
      includedInTotal: true,
      bodyCount: bodies.length,
      bodies: bodyContributions,
      overheadBytes,
    },
    bodies,
  };
}

async function stepRulesMd(root: string, normalize: Normalizer): Promise<StepReport> {
  const path = join(root, "RULES.md");
  const content = await readFile(path, "utf-8");
  return {
    bytes: measuredTextBytes(content, normalize),
    calls: 0,
    includedInTotal: true,
    content: normalize(content),
  };
}

async function stepLessonDigest(ctx: ReplayContext): Promise<StepReport> {
  const { measurement } = await callTool(ctx, "storybloq_lesson_digest", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true };
}

async function stepGitLogFixture(normalize: Normalizer): Promise<StepReport> {
  return {
    bytes: measuredTextBytes(FIXTURE_GIT_LOG_TEXT, normalize),
    calls: 0,
    includedInTotal: true,
    content: normalize(FIXTURE_GIT_LOG_TEXT),
  };
}

async function stepGitLogLive(root: string, normalize: Normalizer): Promise<StepReport> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-10"], { cwd: root });
    return {
      bytes: measuredTextBytes(stdout, normalize),
      calls: 0,
      includedInTotal: true,
      content: normalize(stdout),
    };
  } catch (err) {
    return {
      bytes: 0,
      calls: 0,
      includedInTotal: true,
      status: "incomplete",
      reason: `git log failed: ${(err as Error).message}`,
    };
  }
}

interface RecommendStepResult {
  report: StepReport;
  rows: RecommendRow[];
}

export async function stepRecommend(ctx: ReplayContext): Promise<RecommendStepResult> {
  const mark = ctx.log.length;
  await ctx.client.callTool({ name: "storybloq_recommend", arguments: { count: 10 } });
  const measurement = measureExchange(ctx.log, mark, ctx.normalize);
  const text = responseText(measurement.rawResponse);
  const parsed = deriveRecommendRows(text);
  if (parsed.parseFailed) {
    return { report: buildFailedRecommendReport(measurement, parsed.reason), rows: [] };
  }
  const rows = parsed.rows;

  const issueRows = rows.filter((r) => r.kind === "issue");
  const issueGetCalls: ExchangeMeasurement[] = [];
  let actionableIssueCount = 0;
  let issueGetIncomplete = false;
  let issueGetIncompleteReason: string | undefined;
  let failedCallBytes = 0;
  let failedCallCount = 0;
  for (const row of issueRows) {
    try {
      const { measurement: m, text: issueText } = await callTool(ctx, "storybloq_issue_get", { id: row.id });
      issueGetCalls.push(m);
      if (issueClearsActionabilityBar(parseIssueMarkdown(issueText))) actionableIssueCount++;
    } catch (err) {
      // Retain every issue_get exchange already completed before the
      // failure, plus whatever the failing exchange itself genuinely cost
      // (CallToolFailure carries that even though its interpretation failed).
      issueGetIncomplete = true;
      issueGetIncompleteReason = `issue_get failed for ${row.id}: ${(err as Error).message}`;
      if (err instanceof CallToolFailure) {
        failedCallBytes = err.partialBytes;
        failedCallCount = err.partialCalls;
      }
      break;
    }
  }
  const issueGetBytes = issueGetCalls.reduce((a, m) => a + m.totalBytes, 0) + failedCallBytes;
  const issueGetCallCount = issueGetCalls.length + failedCallCount;

  return {
    report: {
      bytes: measurement.totalBytes + issueGetBytes,
      calls: measurement.calls + issueGetCallCount,
      includedInTotal: true,
      issueGetCalls: issueGetCalls.length,
      actionableIssueCount,
      requestCarriesCountTen:
        (measurement.rawRequest as any)?.params?.arguments?.count === 10,
      ...(issueGetIncomplete ? { status: "incomplete", reason: issueGetIncompleteReason } : {}),
    },
    rows,
  };
}

export interface ContinuationStepResult {
  report: StepReport;
  resolvedId: string | null;
}

export async function stepContinuationCheck(
  ctx: ReplayContext,
  newestHandoverBody: string,
): Promise<ContinuationStepResult> {
  const section = findContinuationSection(newestHandoverBody);
  if (!section) {
    return {
      report: { bytes: 0, calls: 0, includedInTotal: true, present: false },
      resolvedId: null,
    };
  }

  const constructedText = `## Continuation from ${section.slug}\n${section.content}`;
  const constructedBytes = measuredTextBytes(constructedText, ctx.normalize);

  // A "blocked" heading describes blocked work, not a promotion target -- the
  // skill renders the section but never promotes an entity named in it.
  if (section.keyword === "blocked") {
    return {
      report: {
        bytes: constructedBytes,
        calls: 0,
        includedInTotal: true,
        present: true,
        constructedBytes,
        constructedText: ctx.normalize(constructedText),
        walkCalls: 0,
        resolvedId: null,
        suppressed: "blocked-heading section is rendered but never walked for promotion",
      },
      resolvedId: null,
    };
  }

  const ids = extractEntityIds(section.content);
  let resolvedId: string | null = null;
  const walkCalls: ExchangeMeasurement[] = [];
  let walkIncomplete = false;
  let walkIncompleteReason: string | undefined;
  let failedCallBytes = 0;
  let failedCallCount = 0;
  for (const id of ids) {
    try {
      const isIssue = id.startsWith("ISS-");
      const toolName = isIssue ? "storybloq_issue_get" : "storybloq_ticket_get";
      const { measurement, text } = await callTool(ctx, toolName, { id });
      walkCalls.push(measurement);
      const clears = isIssue
        ? issueClearsActionabilityBar(parseIssueMarkdown(text))
        : ticketClearsActionabilityBar(parseTicketMarkdown(text));
      if (clears) {
        resolvedId = id;
        break;
      }
    } catch (err) {
      // Retain every exchange already observed before the failure, plus
      // whatever the failing exchange itself genuinely cost (CallToolFailure
      // carries that even though its interpretation failed); only the
      // unfinished portion of the walk is marked incomplete.
      walkIncomplete = true;
      walkIncompleteReason = `continuation walk failed on ${id}: ${(err as Error).message}`;
      if (err instanceof CallToolFailure) {
        failedCallBytes = err.partialBytes;
        failedCallCount = err.partialCalls;
      }
      break;
    }
  }
  const walkBytes = walkCalls.reduce((a, m) => a + m.totalBytes, 0) + failedCallBytes;
  const walkCallCount = walkCalls.length + failedCallCount;

  const report: StepReport = {
    bytes: constructedBytes + walkBytes,
    calls: walkCallCount,
    includedInTotal: true,
    present: true,
    constructedBytes,
    constructedText: ctx.normalize(constructedText),
    walkCalls: walkCallCount,
    resolvedId,
    ...(walkIncomplete ? { status: "incomplete", reason: walkIncompleteReason } : {}),
  };

  return { report, resolvedId };
}

function stepContextColumnLookup(rows: readonly RecommendRow[]): {
  report: StepReport;
  contextById: Map<string, { context: string; diagnostic: string }>;
} {
  const lookup = lookupContextColumn(rows);
  const contextById = new Map(lookup.map((r) => [r.id, { context: r.context, diagnostic: r.diagnostic }]));
  return {
    report: { bytes: 0, calls: 0, includedInTotal: true, rows: lookup },
    contextById,
  };
}

function stepReadyToWorkTable(
  rows: readonly RecommendRow[],
  contextById: ReadonlyMap<string, { context: string; diagnostic: string }>,
  normalize: Normalizer,
): StepReport {
  const table = renderReadyToWorkTable(rows, contextById);
  const shown = Math.min(5, rows.length);
  return {
    bytes: measuredTextBytes(table, normalize),
    calls: 0,
    includedInTotal: true,
    rowsShown: shown,
    moreCount: rows.length - shown,
    text: normalize(table),
  };
}

async function stepNodeList(ctx: ReplayContext, orchestrator: boolean): Promise<StepReport> {
  if (!orchestrator) {
    return { bytes: 0, calls: 0, includedInTotal: true, gated: true, reason: "non-orchestrator project" };
  }
  const { measurement } = await callTool(ctx, "storybloq_node_list", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true, gated: false };
}

async function readOrchestratorFlag(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, ".story", "config.json"), "utf-8");
    return isOrchestratorConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

// --- fixture mode --------------------------------------------------------------

// --- shared step sequence ----------------------------------------------------
//
// Both fixture and live mode drive the exact same step sequence through the
// exact same stop/retention rules; only the surrounding setup (how the ctx is
// built, which extra live-only meta fields get computed afterward) differs.
// Sharing one sequence means a rule fixed here (stop-on-unverifiable
// reconciliation, partial-progress retention on a late failure) cannot drift
// between the two modes the way two independently maintained copies can.
//
// Retention contract: when a step's downstream PARSING genuinely cannot be
// interpreted, its own already-captured transport bytes/calls are RETAINED
// (the request/response were genuinely sent and measured); only steps that
// DEPEND on that failed parse are marked incomplete. If reconciliation comes
// back "unverifiable" (a fingerprint mismatch persisting after a retried
// guard call), the guard's own vocabulary for that state is "stop; do not
// guess" -- so every downstream step is left unexecuted (zero-cost,
// status:"incomplete") rather than continuing to call tools that the skill
// itself would not have called at that point. If ANYTHING in the sequence
// throws unexpectedly, whatever steps completed before the throw are
// retained as-is; only the remaining, not-yet-run steps are filled with a
// zero-cost crash placeholder. This function never throws.

export async function runReplaySequence(
  ctx: ReplayContext,
  root: string,
  normalize: Normalizer,
): Promise<{
  steps: Record<StepName, StepReport>;
  anyIncomplete: boolean;
  guardVerdict: unknown;
  orchestrator: boolean;
}> {
  let anyIncomplete = false;
  let guardVerdict: unknown = null;
  let orchestrator = false;
  const steps: Partial<Record<StepName, StepReport>> = {};

  // Tracks which step is CURRENTLY running and the log position right
  // before it started. STEP_NAMES' declared order does not match execution
  // order (reconciliation is declared before status but runs after it), so
  // recovery cannot infer "which step crashed" from declaration order --
  // `enter` records it explicitly, right before that step's own work
  // begins. If it throws (a JSON.parse or similar post-processing failure
  // after a call already transmitted), the catch below recovers whatever
  // landed in the log between this mark and the crash and attributes it to
  // the step `enter` named, rather than silently zeroing it.
  let stepBoundaryMark = ctx.log.length;
  let currentStepName: StepName | null = null;
  const enter = (name: StepName): void => {
    currentStepName = name;
    stepBoundaryMark = ctx.log.length;
  };

  const fillRemaining = (reason: string): void => {
    for (const name of STEP_NAMES) {
      if (!(name in steps)) {
        steps[name] = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason };
      }
    }
  };

  // Single exit point: both the early "unverifiable" return and the normal
  // end-of-sequence return go through this, so the two paths cannot drift
  // on which fields the result carries or how step order is normalized.
  const finalize = (): {
    steps: Record<StepName, StepReport>;
    anyIncomplete: boolean;
    guardVerdict: unknown;
    orchestrator: boolean;
  } => {
    const orderedSteps = Object.fromEntries(
      STEP_NAMES.map((name) => [name, steps[name] as StepReport]),
    ) as Record<StepName, StepReport>;
    return { steps: orderedSteps, anyIncomplete, guardVerdict, orchestrator };
  };

  try {
    enter("tool_discovery");
    const discovery = await stepToolDiscovery(ctx);
    steps.tool_discovery = discovery.modeled;
    steps.tool_discovery_reference = discovery.reference;

    enter("session_guard");
    const guard = await stepSessionGuard(ctx);
    steps.session_guard = guard.report;
    guardVerdict = guard.verdict;

    enter("status");
    const status = await stepStatus(ctx);
    steps.status = status.report;

    enter("reconciliation");
    const reconciliation = await stepReconciliation(ctx, guard.verdict, status.payload);
    steps.reconciliation = reconciliation;
    if ((reconciliation as any).status === "incomplete") anyIncomplete = true;

    if ((reconciliation as any).verdict === "unverifiable") {
      anyIncomplete = true;
      fillRemaining(
        "skipped: reconciliation reported an unverifiable session-guard verdict; per the guard's own 'unverifiable: stop, do not guess' semantics the replay does not proceed past this point",
      );
      return finalize();
    }

    enter("recap");
    const recap = await stepRecap(ctx);
    steps.recap = recap;

    enter("handover_latest");
    const handover = await stepHandoverLatest(ctx);
    steps.handover_latest = handover.report;

    enter("rules_md");
    let rulesMd: StepReport;
    try {
      rulesMd = await stepRulesMd(root, normalize);
    } catch {
      rulesMd = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "RULES.md not readable" };
      anyIncomplete = true;
    }
    steps.rules_md = rulesMd;

    enter("lesson_digest");
    const lessonDigest = await stepLessonDigest(ctx);
    steps.lesson_digest = lessonDigest;

    enter("git_log");
    const gitLog = ctx.gitLogMode === "live" ? await stepGitLogLive(root, normalize) : await stepGitLogFixture(normalize);
    if (gitLog.status === "incomplete") anyIncomplete = true;
    steps.git_log = gitLog;

    // stepRecommend never throws on a parse failure: it retains the already-
    // captured request/response bytes and call count in the returned report
    // (status: "incomplete") rather than discarding them, since the exchange
    // genuinely transmitted. `rows` comes back empty in that case, which is
    // what correctly starves the downstream Gate B / context / table steps of
    // anything to depend on below.
    enter("recommend");
    const { report: recommend, rows: recommendRows } = await stepRecommend(ctx);
    if (recommend.status === "incomplete") anyIncomplete = true;
    steps.recommend = recommend;

    // handoverFilenames (and therefore handover_latest's returned bodies) are
    // ordered NEWEST FIRST -- bodies[0] is the most recent handover, the one
    // the Continuation check scans.
    // stepContinuationCheck never throws: a mid-walk failure is caught inside
    // it and reported as status:"incomplete" while retaining every exchange
    // already observed before the failure.
    enter("continuation_check");
    const { report: continuation } = await stepContinuationCheck(ctx, handover.bodies[0] ?? "");
    if (continuation.status === "incomplete") anyIncomplete = true;
    steps.continuation_check = continuation;

    enter("context_column_lookup");
    let contextLookup: { report: StepReport; contextById: Map<string, { context: string; diagnostic: string }> };
    let readyTable: StepReport;
    if (recommend.status === "incomplete") {
      contextLookup = { report: { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "depends on recommend" }, contextById: new Map() };
      readyTable = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "depends on recommend" };
      anyIncomplete = true;
    } else {
      contextLookup = stepContextColumnLookup(recommendRows);
      readyTable = stepReadyToWorkTable(recommendRows, contextLookup.contextById, normalize);
    }
    steps.context_column_lookup = contextLookup.report;
    steps.ready_to_work_table = readyTable;

    enter("node_list");
    orchestrator = await readOrchestratorFlag(root);
    const nodeList = await stepNodeList(ctx, orchestrator);
    steps.node_list = nodeList;
  } catch (err) {
    anyIncomplete = true;
    const reason = `replay step crashed: ${(err as Error).message}`;
    // Recover whatever transport activity the currently in-progress step
    // (tracked by `enter`, not inferred from STEP_NAMES' declared order --
    // reconciliation is declared before status but runs after it) genuinely
    // captured before it crashed. A JSON.parse or similar post-processing
    // failure after a real call still leaves that call's cost sitting in
    // the log; a step that never got as far as calling a tool recovers
    // zero, which is still accurate.
    const recovered = measureLogRange(ctx.log, stepBoundaryMark, ctx.log.length, normalize);
    if (currentStepName && !(currentStepName in steps)) {
      steps[currentStepName] = {
        bytes: recovered.bytes,
        calls: recovered.calls,
        includedInTotal: true,
        status: "incomplete",
        reason,
      };
    }
    fillRemaining(reason);
  }

  return finalize();
}

async function runFixtureMode(fixtureRoot: string): Promise<PrimingCostReport> {
  const root = resolve(fixtureRoot);
  const normalize = buildNormalizer(root);

  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "priming-cost", version: "0.0.0" });
  const { clientTransport, serverTransport, log } = createCapturingLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const ctx: ReplayContext = { root, client, log, normalize, gitLogMode: "fixture" };

  const { steps, anyIncomplete } = await runReplaySequence(ctx, root, normalize);

  await client.close();

  let totalBytes = 0;
  let totalCalls = 0;
  for (const name of STEP_NAMES) {
    const step = steps[name];
    if (step.includedInTotal) {
      totalBytes += step.bytes;
      totalCalls += step.calls;
    }
  }

  return {
    mode: "fixture",
    meta: {
      measuredRoot: normalize(root) as string,
      generatedAt: new Date().toISOString(),
    },
    steps,
    totals: { bytes: totalBytes, calls: totalCalls, status: anyIncomplete ? "observed_subtotal" : "complete" },
    rawLog: log,
  };
}

// --- live mode -------------------------------------------------------------------
//
// Same step sequence and parsing logic as fixture mode (see runReplaySequence
// above). Never throws; always exits 0.

async function runLiveMode(root: string): Promise<PrimingCostReport> {
  const absRoot = resolve(root);
  const normalize = buildNormalizer(absRoot);

  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, absRoot);
  const client = new Client({ name: "priming-cost-live", version: "0.0.0" });
  const { clientTransport, serverTransport, log } = createCapturingLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const ctx: ReplayContext = { root: absRoot, client, log, normalize, gitLogMode: "live" };

  const { steps, anyIncomplete, guardVerdict, orchestrator } = await runReplaySequence(ctx, absRoot, normalize);

  await client.close();

  let totalBytes = 0;
  let totalCalls = 0;
  for (const name of STEP_NAMES) {
    const step = steps[name];
    if (step.includedInTotal) {
      totalBytes += step.bytes;
      totalCalls += step.calls;
    }
  }

  let commit: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: absRoot });
    commit = stdout.trim();
  } catch {
    commit = null;
  }

  let dirty: boolean | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: absRoot });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = null;
  }

  const guardSessions = ((guardVerdict as { sessions?: unknown[] } | null)?.sessions ?? []) as unknown[];
  const sessionInventory = {
    count: guardSessions.length,
    ids: guardSessions
      .map((s) => (s as { sessionId?: unknown })?.sessionId)
      .filter((id): id is string => typeof id === "string"),
  };

  let installedSkillHash: string | null = null;
  try {
    const skillPath = join(homedir(), ".claude", "skills", "story", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");
    installedSkillHash = createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    installedSkillHash = null;
  }

  return {
    mode: "live",
    meta: {
      measuredRoot: normalize(absRoot) as string,
      generatedAt: new Date().toISOString(),
      commit,
      dirty,
      sessionInventory,
      installedSkillHash,
      orchestrator,
    },
    steps,
    totals: { bytes: totalBytes, calls: totalCalls, status: anyIncomplete ? "observed_subtotal" : "complete" },
    rawLog: log,
  };
}

// --- CLI entry ---------------------------------------------------------------

export function buildCrashReport(root: string, error: Error): PrimingCostReport {
  const zeroStep: StepReport = {
    bytes: 0,
    calls: 0,
    includedInTotal: true,
    status: "incomplete",
    reason: `live replay crashed: ${error.message}`,
  };
  const steps = Object.fromEntries(STEP_NAMES.map((name) => [name, zeroStep])) as Record<
    StepName,
    StepReport
  >;
  return {
    mode: "live",
    meta: { measuredRoot: root, generatedAt: new Date().toISOString() },
    steps,
    totals: { bytes: 0, calls: 0, status: "observed_subtotal" },
    rawLog: [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--emit-json") {
    const fixtureRoot = args[1];
    if (!fixtureRoot) {
      console.error("--emit-json requires a fixture root argument");
      process.exit(1);
    }
    const report = await runFixtureMode(fixtureRoot);
    console.log(JSON.stringify(report));
    return;
  }
  if (args[0] === "--live") {
    const root = args[1] ?? process.cwd();
    // Live mode's own design goal is "never throws, always exits 0" -- but
    // no single step can guarantee that against an arbitrary real project
    // (a corrupted ledger file, a tool that genuinely rejects). This is the
    // last line of defense: if anything anywhere in the live replay throws
    // regardless, still emit a valid, minimally-shaped report rather than a
    // bare stack trace and a nonzero exit.
    try {
      const report = await runLiveMode(root);
      console.log(JSON.stringify(report, null, 2));
    } catch (err) {
      console.log(JSON.stringify(buildCrashReport(root, err as Error), null, 2));
    }
    return;
  }
  console.error("usage: priming-cost.ts --emit-json <fixtureRoot> | --live [root]");
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
