/**
 * T-499: the push surfaces. Everything here is best-effort and bounded:
 * a failure or an abandoned budget returns nothing, and the caller's
 * response goes out untouched.
 *
 *   banner       a prefix (MCP md), a sibling key (MCP json), an appended
 *                line (CLI md) or one STDERR line (CLI json) at advisory or
 *                imperative, for the CALLER's own session under the binding
 *                rule: record exists, not ended, live non-null era equal to
 *                the record's. A persistent MCP server across `/clear`
 *                inherits an ended id and therefore pushes nothing.
 *   directive    the guide's imperative line for the autonomous OWNER.
 *   stamp        after a handover is written, the caller's record records
 *                it against the current compaction boundary.
 */

import { isPresenceEnabled } from "../../presence/handler.js";
import type { SessionIntelSample } from "../../presence/session-intel-fields.js";
import { LIFECYCLE_LOCK_BUDGET_MS } from "../presence-enrichment.js";
import { readSessionIntelConfig, type SessionIntelConfig } from "./config.js";
import { peekPending, readPresenceRecord, reconcileIntel, reconcileUnderLock, resolveCallerBinding, stampHandover, type HandoverStampOutcome } from "./presence-bridge.js";
import { sampleSession } from "./query.js";
import { locateTranscript } from "./transcript-locate.js";
import { scanTail } from "./transcript-scan.js";

export const BANNER_SOFT_BUDGET_MS = 150;

/** The banner's payload: the compact sample plus a rendered line. */
export interface TokenPressureBanner {
  readonly state: "advisory" | "imperative";
  readonly pct: number | null;
  readonly contextTokens: number | null;
  readonly ceiling: number | null;
  readonly ceilingSource: SessionIntelSample["ceilingSource"];
  readonly ceilingConfidence: SessionIntelSample["ceilingConfidence"];
  readonly sampledAt: string;
  readonly suppressedBy: "handover" | null;
  readonly text: string;
}

export interface BannerOptions {
  readonly explicitTaskId?: string | null;
  readonly cwd?: string;
  readonly now?: number;
  readonly sampledBy?: "mcp-refresh" | "query";
  readonly softBudgetMs?: number;
  /** Test seams. */
  readonly clock?: () => number;
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
}

const pctText = (p: number | null) => (p === null ? "n/a" : `${Math.round(p * 100)}%`);

export function renderBannerText(sample: SessionIntelSample, surface: "mcp" | "cli"): string {
  const where = surface === "mcp" ? "storybloq_handover_create" : "storybloq handover create";
  const head = `Context pressure ${sample.state.toUpperCase()}: ${pctText(sample.pct)} of the expected auto-compact point (${sample.contextTokens?.toLocaleString() ?? "n/a"} tokens; source ${sample.ceilingSource}${sample.ceilingConfidence ? `, ${sample.ceilingConfidence} confidence` : ""}).`;
  if (sample.state === "imperative") return `${head} Write a handover now via ${where}, then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue.`;
  return `${head}${sample.suppressedBy === "handover" ? " A recent handover holds this at advisory: keep working." : ""} Plan a handover before the next large step, and keep working.`;
}

/**
 * The usable sample for the CALLER's record, refreshed by one bound tail
 * sample when the stored one is older than `maxSampleAgeMs`. Null on any
 * gate: feature or banner off, presence off, unbound caller, no usable
 * sample, unresolved pending compaction, or the soft budget exceeded.
 */
export function tokenPressureBannerFor(root: string, opts: BannerOptions = {}, surface: "mcp" | "cli" = "mcp"): TokenPressureBanner | null {
  try {
    const clock = opts.clock ?? Date.now;
    const startedAt = clock();
    const now = opts.now ?? startedAt;
    const softMs = opts.softBudgetMs ?? BANNER_SOFT_BUDGET_MS;
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled || !cfg.banner) return null;
    if (!isPresenceEnabled(root)) return null;
    const binding = resolveCallerBinding(root, opts.explicitTaskId);
    if (!binding.bound || !binding.sessionId) return null;
    if (clock() - startedAt > softMs) return null;

    let intel = readPresenceRecord(root, binding.sessionId)?.sessionIntel ?? null;
    let sample = intel?.lastSample ?? null;
    const stale = sample === null || now - Date.parse(sample.sampledAt) > cfg.maxSampleAgeMs;
    if (stale) {
      const r = sampleSession({
        root,
        cwd: opts.cwd ?? root,
        sampledBy: opts.sampledBy ?? "mcp-refresh",
        explicitTaskId: binding.sessionId,
        allowGlob: false,
        now,
        projectsDir: opts.projectsDir,
        userSettingsPath: opts.userSettingsPath,
        budget: { startedAt, softMs, clock },
      });
      if (!r.usable || r.presence !== "persisted") return null;
      intel = readPresenceRecord(root, binding.sessionId)?.sessionIntel ?? null;
      sample = intel?.lastSample ?? null;
    }
    if (!intel || !sample) return null;
    if (clock() - startedAt > softMs) return null;
    // Same usability rule as the status projection: the sample must survive
    // reconciliation of the pending set unchanged.
    const rec = reconcileIntel(intel, null, peekPending(root, binding.sessionId, now), cfg, now);
    if (rec.status !== "complete" || rec.intel.lastSample !== sample) return null;
    if (sample.state !== "advisory" && sample.state !== "imperative") return null;
    return {
      state: sample.state,
      pct: sample.pct,
      contextTokens: sample.contextTokens,
      ceiling: sample.ceiling,
      ceilingSource: sample.ceilingSource,
      ceilingConfidence: sample.ceilingConfidence,
      sampledAt: sample.sampledAt,
      suppressedBy: sample.suppressedBy,
      text: renderBannerText(sample, surface),
    };
  } catch {
    return null;
  }
}

/** The JSON sibling shape (the rendered text is left out of machine output). */
export function bannerJson(b: TokenPressureBanner): Record<string, unknown> {
  const { text: _text, ...rest } = b;
  return rest;
}

/**
 * Applies a banner to an MCP result. Nothing changes on an error result.
 * md: a prefix block. json: a sibling key `tokenPressure` when the text is
 * a JSON object; any other shape is left untouched.
 */
export function applyBannerToMcpText(text: string, format: "md" | "json", banner: TokenPressureBanner | null): string {
  if (!banner) return text;
  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
      return JSON.stringify({ ...(parsed as Record<string, unknown>), tokenPressure: bannerJson(banner) }, null, 2);
    } catch {
      return text;
    }
  }
  return `${banner.text}\n\n${text}`;
}

/** CLI: md is appended to stdout; json gets ONE line on stderr so the stdout envelope and `--raw` stay parseable. */
export function cliBannerFor(root: string, format: "md" | "json", opts: BannerOptions = {}): { readonly stdout: string | null; readonly stderr: string | null } {
  const banner = tokenPressureBannerFor(root, { sampledBy: "query", ...opts }, "cli");
  if (!banner) return { stdout: null, stderr: null };
  return format === "json" ? { stdout: null, stderr: `[storybloq] ${banner.text}` } : { stdout: banner.text, stderr: null };
}

// ---------------------------------------------------------------------------
// Guide directive
// ---------------------------------------------------------------------------

/**
 * The autonomous OWNER's imperative directive, from its record only (the
 * guide never scans a transcript). Null unless the owner's usable sample is
 * imperative and `guideDirective` is on. Not a state transition.
 */
export function guideDirectiveFor(root: string, ownerClaudeSessionId: string | null | undefined, now: number = Date.now(), cfg: SessionIntelConfig = readSessionIntelConfig(root)): string | null {
  try {
    if (!ownerClaudeSessionId || !cfg.enabled || !cfg.guideDirective) return null;
    if (!isPresenceEnabled(root)) return null;
    const intel = readPresenceRecord(root, ownerClaudeSessionId)?.sessionIntel ?? null;
    const sample = intel?.lastSample ?? null;
    if (!intel || !sample || sample.state !== "imperative") return null;
    const rec = reconcileIntel(intel, null, peekPending(root, ownerClaudeSessionId, now), cfg, now);
    if (rec.status !== "complete" || rec.intel.lastSample !== sample) return null;
    return `Context pressure imperative (${pctText(sample.pct)} of ceiling, source ${sample.ceilingSource}${sample.ceilingConfidence ? `, ${sample.ceilingConfidence} confidence` : ""}): write a handover now via storybloq_handover_create, then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handover stamp
// ---------------------------------------------------------------------------

export type HandoverStampResult =
  | { readonly status: "stamped"; readonly sessionId: string; readonly outcome: HandoverStampOutcome }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * After a successful `handover create`: reconcile the caller's record (a
 * boundary the tail shows is applied first, so the stamp lands on the
 * CURRENT compaction), then stamp it under the binding rule. Best-effort.
 */
export function stampHandoverForCaller(root: string, opts: { explicitTaskId?: string | null; cwd?: string; now?: number; projectsDir?: string } = {}): HandoverStampResult {
  try {
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled) return { status: "skipped", reason: "sessionIntel disabled" };
    if (!isPresenceEnabled(root)) return { status: "skipped", reason: "presence disabled" };
    const binding = resolveCallerBinding(root, opts.explicitTaskId);
    if (!binding.bound || !binding.sessionId || !binding.era) return { status: "skipped", reason: binding.reason };
    const now = opts.now ?? Date.now();
    const sessionId = binding.sessionId;
    const record = readPresenceRecord(root, sessionId);
    const located = locateTranscript({ sessionId, cwd: opts.cwd ?? root, hint: record?.sessionIntel?.transcriptPath ?? null, allowGlob: false, projectsDir: opts.projectsDir });
    const tail = located ? scanTail({ path: located.path, sessionId, era: null, revisionSeen: null, epochSince: null }) : null;
    reconcileUnderLock({ root, sessionId, cfg, tailBoundaries: tail?.boundaries ?? [], transcriptPath: located?.path ?? null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
    // tokensAtHandover is taken from the record INSIDE the stamp's lock (the
    // null fallback in stampHandover reads lastSample there), so the token
    // count and handoverBoundaryAt always describe the same locked record; a
    // sampler or compaction landing between the reconcile and the stamp
    // cannot pair an old count with a newer boundary.
    const outcome = stampHandover(root, sessionId, binding.era, null, now);
    return { status: "stamped", sessionId, outcome };
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }
}
