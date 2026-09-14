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
 * Every result names its source, confidence and basis. A scanned high-water
 * mark never promotes: above the forecast it keeps the forecast and raises a
 * conflict, which the sampler floors at advisory. An observed AUTO BOUNDARY
 * does promote (ISS-1197 commit 3): it measures where compaction actually
 * fired, so a forecast below one this session has already passed is raised to
 * it rather than left to report "97%" of a point already behind.
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

/**
 * ISS-1197 commit 3: the highest `preTokens` THIS session has actually
 * auto-compacted at, across every era. Era-agnostic on purpose: when the
 * boundary belongs to a previous era, `measured-session` cannot consume it and
 * the resolver falls through to a forecast, which is exactly the case that
 * went wrong in the field (an auto boundary at 416,642 under a 416,250
 * forecast, read out as "97%" of a point the session was already past).
 *
 * Manual and unclassified triggers are excluded: a user compacting early
 * measures nothing about where compaction fires on its own.
 */
function observedAutoFloor(ledger: readonly LedgerEntry[], sessionId: string): number | null {
  let floor: number | null = null;
  for (const e of ledger) {
    if (e.sessionId !== sessionId || e.trigger !== "auto" || e.preTokens === null) continue;
    if (floor === null || e.preTokens > floor) floor = e.preTokens;
  }
  return floor;
}

function withConflict(r: CeilingResolution, hwm: number | null, notes: readonly string[], observedFloor: number | null): CeilingResolution {
  let ceiling = r.ceiling;
  let basis = r.basis;
  let conflict = r.conflict;
  // An auto boundary is a MEASUREMENT of the fire point, so a forecast below
  // one is not in conflict with the evidence, it has been replaced by it.
  //
  // Not applied to `measured-session`: that source is already this session's
  // own auto boundaries, and its median is the deliberate robust estimator of
  // where the NEXT compaction fires. Raising it to the max of the same set
  // would turn the median into a max on nearly every real ledger, which is a
  // different change from the one this fixes. Confidence is untouched either
  // way: the raise sharpens the number, not the provenance.
  if (r.source !== "measured-session" && ceiling !== null && observedFloor !== null && observedFloor > ceiling) {
    ceiling = observedFloor;
    basis = `${basis}; raised to observed boundary ${observedFloor}`;
  }
  // Judged against the RAISED ceiling, so a boundary that explains the
  // overshoot clears the conflict instead of reporting it forever. A scanned
  // high-water mark is not evidence of the same kind and never raises: it
  // proves the context got that big, not that compaction fires there.
  if (ceiling !== null && hwm !== null && hwm > ceiling) conflict = conflict ? `${conflict}; high-water exceeds forecast` : "high-water exceeds forecast";
  return { ...r, ceiling, conflict, basis: notes.length ? `${basis}; config: ${notes.join("; ")}` : basis, highWaterMark: hwm };
}

export function resolveCeiling(input: ResolveCeilingInput): CeilingResolution {
  const { cfg, target, ledger, sessionId } = input;
  // ISS-1197 commit 3: computed once, applied by `withConflict` to whichever
  // source wins, so every path gets the same treatment.
  const floor = observedAutoFloor(ledger, sessionId);
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
      }, input.highWaterMark, cfg.notes, floor);
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
      }, input.highWaterMark, cfg.notes, floor);
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
    }, input.highWaterMark, cfg.notes, floor);
  }
  if (input.liveSetting) {
    return withConflict({
      ...base,
      ceiling: cfg.ceilingFraction * input.liveSetting.value,
      source: "setting",
      confidence: "medium",
      autoCompactWindowAtStart: null,
      basis: `${cfg.ceilingFraction} x autoCompactWindow ${input.liveSetting.value} (${input.liveSetting.basis})`,
    }, input.highWaterMark, cfg.notes, floor);
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
    }, input.highWaterMark, cfg.notes, floor);
  }

  // 5. unknown
  return withConflict({
    ...base,
    ceiling: null,
    source: "unknown",
    confidence: null,
    basis: "no capture, no setting, no measured boundary, no model evidence",
  }, input.highWaterMark, cfg.notes, floor);
}
