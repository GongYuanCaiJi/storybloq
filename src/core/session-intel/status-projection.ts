/**
 * T-499: the coarse `tokenPressure` projection for `.story/status.json`.
 *
 * ONE function for BOTH writers (the Stop hook and the guide), reading the
 * autonomous OWNER's presence record and applying the same usability rule
 * the samplers apply, so the two writers cannot disagree and the ISS-1012
 * churn gate can still skip an unchanged file. Coarse on purpose: a state,
 * a 5-point percentage bucket and the ceiling's provenance. The full sample
 * stays on the presence record.
 */

import { isPresenceEnabled } from "../../presence/handler.js";
import type { CeilingConfidence, CeilingSource, TokenPressureState } from "../../presence/session-intel-fields.js";
import { readSessionIntelConfig } from "./config.js";
import { peekPending, readPresenceRecord, reconcileIntel } from "./presence-bridge.js";

export interface TokenPressureStatus {
  readonly state: TokenPressureState;
  /** Percentage of the ceiling floored to a multiple of 5; null when no ceiling. */
  readonly pctBucket: number | null;
  readonly ceilingSource: CeilingSource;
  readonly ceilingConfidence: CeilingConfidence | null;
}

export function pctBucketOf(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.floor((pct * 100) / 5) * 5);
}

/**
 * Null means "nothing to project" (no session id, presence or the feature
 * off, no record, no sample yet): the field is omitted. A sample whose
 * reconciliation is incomplete (a compaction may be in flight) projects as
 * `unknown` rather than as the stale state.
 */
export function readCoarseTokenPressureForSession(
  root: string,
  session: { readonly claudeCodeSessionId?: string | null },
  now: number = Date.now(),
): TokenPressureStatus | null {
  try {
    const sessionId = session.claudeCodeSessionId ?? null;
    if (!sessionId) return null;
    if (!isPresenceEnabled(root)) return null;
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled) return null;
    const intel = readPresenceRecord(root, sessionId)?.sessionIntel ?? null;
    const sample = intel?.lastSample ?? null;
    if (!intel || !sample) return null;
    // The same pure reconciliation the samplers apply, on an in-memory copy.
    // The sample is taken from the RECONCILED subtree: an expired pending
    // event applies an assumed reset that clears the sample while reporting
    // "complete", and the pre-compaction sample must not resurface as usable.
    const pending = peekPending(root, sessionId, now);
    const r = reconcileIntel(intel, null, pending, cfg, now);
    const usable = r.status === "complete" && r.intel.lastSample === sample;
    return {
      state: usable ? sample.state : "unknown",
      pctBucket: usable ? pctBucketOf(sample.pct) : null,
      ceilingSource: sample.ceilingSource,
      ceilingConfidence: sample.ceilingConfidence,
    };
  } catch {
    return null;
  }
}
