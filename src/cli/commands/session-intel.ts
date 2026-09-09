/**
 * T-499: `storybloq session intel` -- one call that tells an agent its
 * current context usage, the expected auto-compaction point and where that
 * number came from, plus the session facts the transcript carries.
 *
 * Works without `.story/` (transcript-only, read-only). CLI and MCP share
 * this handler so both surfaces return identical numbers.
 */

import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { sampleSession, type SessionIntelResult } from "../../core/session-intel/query.js";

export interface SessionIntelOptions {
  readonly cwd?: string;
  readonly format?: "json" | "md";
  readonly sessionId?: string | null;
  readonly transcript?: string | null;
  readonly callerModel?: string | null;
  readonly full?: boolean;
  readonly clientTaskId?: string | null;
  readonly sampledBy?: "query" | "mcp-refresh";
  /** Test seams, threaded to the engine unchanged. */
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
  readonly fullBudgetBytes?: number;
}

export interface SessionIntelCommandResult {
  readonly output: string;
  readonly result: SessionIntelResult;
  readonly errorCode?: string;
}

/**
 * The same upward discovery every other command uses, so a call from a
 * project subdirectory finds the project (its capture, ledger, config and
 * handover state) instead of silently answering transcript-only. The
 * invocation cwd is kept for transcript lookup. Unreadable `.story/` reads
 * as no project.
 */
function projectRootFor(cwd: string): string | null {
  try { return discoverProjectRoot(cwd); } catch { return null; }
}

function pctText(p: number | null): string {
  return p === null ? "n/a" : `${(p * 100).toFixed(1)}%`;
}

export function formatSessionIntelMd(r: SessionIntelResult): string {
  const lines: string[] = ["# Session intel", ""];
  const p = r.pressure;
  if (!p || !r.usable) {
    lines.push(`Token pressure: unknown (${r.unusableReason ?? "no pressure available"})`);
  } else {
    const c = p.ceiling;
    lines.push(`Token pressure: ${p.state.toUpperCase()}${p.suppressedBy ? " (imperative suppressed by a recent handover)" : ""}`);
    lines.push(`- Context in use: ${p.contextTokens?.toLocaleString() ?? "n/a"} tokens (${pctText(p.pct)} of the expected auto-compact point)`);
    lines.push(`- Expected auto-compact at: ${c.ceiling === null ? "unknown" : Math.round(c.ceiling).toLocaleString()} tokens, source ${c.source}${c.confidence ? ` (${c.confidence} confidence)` : ""}`);
    lines.push(`- Basis: ${c.basis}`);
    if (c.conflict) lines.push(`- Conflict: ${c.conflict}`);
    lines.push(`- Headroom: ${p.headroom?.toLocaleString() ?? "n/a"} tokens; jump allowance ${p.jumpAllowance?.toLocaleString() ?? "n/a"} (${p.jumpAllowanceBasis})`);
    if (p.reason) lines.push(`- Why: ${p.reason}`);
    if (p.state === "imperative") lines.push("", "Write a handover now (storybloq handover create / storybloq_handover_create), then continue.");
    else if (p.state === "advisory") lines.push("", "Plan a handover before the next large step.");
  }
  lines.push("");
  lines.push(`Session ${r.sessionId ?? "unknown"}: ${r.binding} (${r.bindingReason}); coverage ${r.coverage}, ${r.scannedBytes.toLocaleString()} bytes scanned${r.truncationReason ? `; ${r.truncationReason}` : ""}`);
  if (r.transcriptPath) lines.push(`Transcript: ${r.transcriptPath}`);
  const s = r.session;
  if (s) {
    const facts: string[] = [];
    if (s.startedAt) facts.push(`started ${s.startedAt}`);
    if (s.version) facts.push(`Claude Code ${s.version}`);
    if (s.entrypoint) facts.push(`entrypoint ${s.entrypoint}`);
    if (s.gitBranch) facts.push(`branch ${s.gitBranch}`);
    if (s.permissionMode) facts.push(`permissions ${s.permissionMode}`);
    if (s.effort) facts.push(`effort ${s.effort}`);
    if (s.aiTitle) facts.push(`title "${s.aiTitle}"`);
    if (s.slug) facts.push(`slug ${s.slug}`);
    if (s.bridgeSessionId) facts.push(`bridge ${s.bridgeSessionId}`);
    if (facts.length) lines.push(`Facts: ${facts.join("; ")}`);
    if (s.models.length) lines.push(`Models: ${s.models.map((m) => m.model).join(" -> ")}${p?.oneMillionFlag ? " (1M context)" : ""}`);
    if (s.turns) lines.push(`Turns observed: ${s.turns.assistant} assistant, ${s.turns.user} user (user count includes peer messages)`);
    lines.push(`Compactions observed: ${s.compactions.autoObserved} auto, ${s.compactions.manualObserved} manual${s.compactions.unknownObserved ? `, ${s.compactions.unknownObserved} unknown` : ""}${s.compactions.last ? `; last ${s.compactions.last.timestamp}` : ""}`);
  }
  if (r.callerModelMismatch) lines.push(`Caller model mismatch: caller says ${r.callerModelMismatch.caller}, transcript says ${r.callerModelMismatch.transcript ?? "unknown"}`);
  lines.push(`Provenance: era ${r.provenance.era ?? "none"}, capture ${r.provenance.capture ? `${r.provenance.capture.captureKind} (autoCompactWindow ${r.provenance.capture.autoCompactWindowAtStart ?? "absent"})` : "none"}`);
  lines.push(`Presence: ${r.presence}${r.presenceReason ? ` (${r.presenceReason})` : ""}`);
  if (r.config.notes.length) lines.push(`Config notes: ${r.config.notes.join("; ")}`);
  return lines.join("\n");
}

export function handleSessionIntel(options: SessionIntelOptions = {}): SessionIntelCommandResult {
  const cwd = options.cwd ?? process.cwd();
  const root = projectRootFor(cwd);
  const result = sampleSession({
    root,
    cwd,
    sampledBy: options.sampledBy ?? "query",
    sessionId: options.sessionId ?? null,
    transcriptPath: options.transcript ?? null,
    callerModel: options.callerModel ?? null,
    full: options.full ?? false,
    explicitTaskId: options.clientTaskId ?? null,
    allowGlob: true,
    projectsDir: options.projectsDir,
    userSettingsPath: options.userSettingsPath,
    fullBudgetBytes: options.fullBudgetBytes,
  });
  const format = options.format ?? "md";
  const output = format === "json" ? JSON.stringify({ ok: true, data: result }, null, 2) : formatSessionIntelMd(result);
  // A Codex client short-circuits to "unknown" by design: an answer, not a
  // lookup failure. For Claude, no identity or no authorized transcript is.
  const notFound = result.client === "claude" && (result.sessionId === null || result.transcriptPath === null);
  return { output, result, errorCode: notFound ? "not_found" : undefined };
}
