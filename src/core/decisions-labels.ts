import { DECISIONS_LIFECYCLE_ORDER, decisionsSectionTitle } from "./decisions-listing.js";
import { CURRENT_LABEL, PROJECTION_RESOLUTION_KINDS } from "./decisions-projection.js";
import { rulingAttributionCaveat } from "./ruling.js";

/**
 * T-528: the labels the Mac app shows beside the projection, generated from the
 * functions that produce them for the CLI, so the two surfaces cannot drift.
 * `scripts/export-labels.ts` writes this to `test/fixtures/ruling-labels.json`;
 * a drift test regenerates it in memory and compares.
 */
export const LABELS_FIXED_RECORDER = { client: "claude", id: "fixture-recorder" } as const;

export function buildRulingLabels(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    lifecycles: [...DECISIONS_LIFECYCLE_ORDER],
    sectionTitles: Object.fromEntries(DECISIONS_LIFECYCLE_ORDER.map((lc) => [lc, decisionsSectionTitle(lc)])),
    resolutionKinds: [...PROJECTION_RESOLUTION_KINDS],
    currentLabel: CURRENT_LABEL,
    attributionCaveat: {
      recordedBy: { ...LABELS_FIXED_RECORDER },
      text: rulingAttributionCaveat(LABELS_FIXED_RECORDER),
    },
  };
}

export function serializeRulingLabels(): string {
  return JSON.stringify(buildRulingLabels(), null, 2) + "\n";
}
