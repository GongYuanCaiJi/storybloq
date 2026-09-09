/**
 * T-499: the ceiling resolver. Pure. Precedence:
 *   1 measured-session  median preTokens of THIS session's auto boundaries
 *                       attributed to the target's non-null era;
 *   2 measured-project  other sessions' auto boundaries with the SAME
 *                       captured window, non-null era and startup capture
 *                       (>= 2 sessions, >= 5 boundaries);
 *   3 setting           ceilingFraction x autoCompactWindowAtStart;
 *   4 model             ceilingFraction x native window (1M flag or 200k);
 *   5 unknown.
 * Every result names its source, confidence and basis. Overshoot never
 * promotes: a high-water mark above the forecast keeps the forecast and
 * raises a conflict, which the sampler floors at advisory.
 */

import type { SessionIntelConfig } from "./config.js";
import type { LedgerEntry } from "./boundary-ledger.js";
import type { CeilingResolution, ModelEvidence, TargetProvenance } from "./types.js";

export interface ResolveCeilingInput {
  readonly sessionId: string;
  readonly target: TargetProvenance;
  readonly ledger: readonly LedgerEntry[];
  /** Transcript-only or unbound mode: a live settings read with no capture. */
  readonly liveSetting: { readonly value: number; readonly basis: string } | null;
  readonly lastAssistantModel: string | null;
  readonly oneMillionFlag: boolean | null;
  readonly modelEvidence: ModelEvidence;
  readonly highWaterMark: number | null;
  readonly cfg: SessionIntelConfig;
}

export const NATIVE_WINDOW_1M = 1_000_000;
export const NATIVE_WINDOW_DEFAULT = 200_000;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const ts = (e: LedgerEntry) => Date.parse(e.timestamp);

function withConflict(r: CeilingResolution, hwm: number | null, notes: readonly string[]): CeilingResolution {
  let conflict = r.conflict;
  if (r.ceiling !== null && hwm !== null && hwm > r.ceiling) conflict = conflict ? `${conflict}; high-water exceeds forecast` : "high-water exceeds forecast";
  const basis = notes.length ? `${r.basis}; config: ${notes.join("; ")}` : r.basis;
  return { ...r, conflict, basis, highWaterMark: hwm };
}

export function resolveCeiling(input: ResolveCeilingInput): CeilingResolution {
  const { cfg, target, ledger, sessionId } = input;
  const capture = target.capture;
  const captureKind = capture?.captureKind ?? "absent";
  const window = capture?.autoCompactWindowAtStart ?? null;
  const base = {
    sampleCount: 0,
    independentSessions: 0,
    effectiveSampleWindow: 0,
    autoCompactWindowAtStart: window,
    captureKind,
    nativeWindow: null as number | null,
    highWaterMark: input.highWaterMark,
    conflict: null as string | null,
  };

  // 1. measured-session
  if (target.era !== null) {
    const own = ledger
      .filter((e) => e.sessionId === sessionId && e.trigger === "auto" && e.era !== null && e.era === target.era && e.preTokens !== null)
      .sort((a, b) => ts(b) - ts(a))
      .slice(0, cfg.boundarySampleCount);
    if (own.length > 0) {
      const reduced = own.length < cfg.boundarySampleCount ? ` (window ${own.length} of ${cfg.boundarySampleCount} configured; ledger holds fewer)` : "";
      return withConflict({
        ...base,
        ceiling: median(own.map((e) => e.preTokens!)),
        source: "measured-session",
        confidence: own.length >= 3 ? "high" : "medium",
        sampleCount: own.length,
        independentSessions: 1,
        effectiveSampleWindow: own.length,
        basis: `median preTokens of ${own.length} auto boundaries in this session's process era${reduced}`,
      }, input.highWaterMark, cfg.notes);
    }
  }

  // 2. measured-project
  if (capture && window !== null) {
    const pool = ledger.filter(
      (e) => e.sessionId !== sessionId && e.trigger === "auto" && e.era !== null && e.captureKind === "startup" && e.autoCompactWindowAtStart === window && e.preTokens !== null,
    );
    // Select the sample FIRST, then judge diversity on what is actually
    // pooled: three sessions in the ledger prove nothing if the newest
    // window is one session's boundaries.
    const sample = [...pool].sort((a, b) => ts(b) - ts(a)).slice(0, Math.max(cfg.boundarySampleCount, 5));
    const sessions = new Set(sample.map((e) => e.sessionId));
    if (sessions.size >= 2 && sample.length >= 5) {
      return withConflict({
        ...base,
        ceiling: median(sample.map((e) => e.preTokens!)),
        source: "measured-project",
        confidence: sessions.size >= 3 ? "high" : "medium",
        sampleCount: sample.length,
        independentSessions: sessions.size,
        effectiveSampleWindow: sample.length,
        basis: `median preTokens of ${sample.length} auto boundaries from ${sessions.size} other sessions captured at startup with autoCompactWindow ${window}`,
      }, input.highWaterMark, cfg.notes);
    }
  }

  // 3. setting
  if (window !== null) {
    return withConflict({
      ...base,
      ceiling: cfg.ceilingFraction * window,
      source: "setting",
      confidence: captureKind === "startup" ? "high" : "medium",
      basis: `${cfg.ceilingFraction} x autoCompactWindow ${window} captured ${captureKind === "startup" ? "at process start" : "late"}`,
    }, input.highWaterMark, cfg.notes);
  }
  if (input.liveSetting) {
    return withConflict({
      ...base,
      ceiling: cfg.ceilingFraction * input.liveSetting.value,
      source: "setting",
      confidence: "medium",
      autoCompactWindowAtStart: null,
      basis: `${cfg.ceilingFraction} x autoCompactWindow ${input.liveSetting.value} (${input.liveSetting.basis})`,
    }, input.highWaterMark, cfg.notes);
  }

  // 4. model
  if (input.lastAssistantModel !== null) {
    const nativeWindow = input.oneMillionFlag ? NATIVE_WINDOW_1M : NATIVE_WINDOW_DEFAULT;
    const evidence = input.modelEvidence;
    return withConflict({
      ...base,
      ceiling: cfg.ceilingFraction * nativeWindow,
      source: "model",
      confidence: evidence === "full" ? "medium" : "low",
      nativeWindow,
      conflict: evidence === "none" ? "no model-window evidence" : null,
      basis: `${cfg.ceilingFraction} x native window ${nativeWindow} for ${input.lastAssistantModel} (${evidence === "none" ? "no model-window record; 200k assumed" : `1M flag ${input.oneMillionFlag ? "set" : "not set"} from ${evidence} scan`})`,
    }, input.highWaterMark, cfg.notes);
  }

  // 5. unknown
  return withConflict({
    ...base,
    ceiling: null,
    source: "unknown",
    confidence: null,
    basis: "no capture, no setting, no measured boundary, no model evidence",
  }, input.highWaterMark, cfg.notes);
}
