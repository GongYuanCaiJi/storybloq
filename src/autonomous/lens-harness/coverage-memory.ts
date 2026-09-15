/**
 * ISS-950: the cross-call coverage memory, per reviewId.
 *
 * The lens server decides a skip's basis within ONE review session. This
 * harness calls `runMergerPipeline` once per synthesize, and two synthesize
 * calls for the same review are two separate calls the server never sees
 * together. Two facts therefore have no owner but this side:
 *
 *  - THE DOWNGRADE-ONLY RULE. A basis is trusted downward only. Once a lens
 *    has skipped on a change the server judged applicable, a later call cannot
 *    raise that skip to `not-applicable` by presenting a narrower diff. The
 *    server cannot enforce it because it has no record of the earlier call.
 *  - THE RELABEL (acceptance 5). The field harm is a lens that skips, pays the
 *    cap, and is resubmitted as `ok` with zero findings in the NEXT synthesize:
 *    the same analysis under a different label. The server's own relabel rule
 *    is scoped to one dispatch, so it is blind to this shape by construction.
 *
 * Both need memory that survives the process, because a synthesize call is a
 * single MCP tool invocation and the next one may run in a different process
 * entirely. It lives in the session TELEMETRY directory beside the other
 * per-session review records, and every read and write is best-effort: losing
 * it degrades to the pre-ISS-950 behaviour (a basis computed fresh, no relabel
 * flag), which is a weaker check, never a wrong one.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LensCoverageBasis, LensCoverageEntry } from "@storybloq/lenses";
import { telemetryDirPath } from "../liveness.js";

const MEMORY_FILE = "lens-coverage-memory.json";

/** What an earlier synthesize established about one lens in one review. */
export interface LensCoverageRecord {
  /** This lens has submitted `skipped` at least once in this review. */
  readonly everSkipped: boolean;
  /** The basis the VERDICT carried, after the server confirmed or demoted it. */
  readonly basis?: LensCoverageBasis;
}

/** lensId -> what is known about it. */
export type LensCoverageMemory = Readonly<Record<string, LensCoverageRecord>>;

/** reviewId -> that review's lens records. The on-disk shape. */
type MemoryFile = Record<string, Record<string, LensCoverageRecord>>;

export function coverageMemoryPath(sessionDir: string): string {
  return join(telemetryDirPath(sessionDir), MEMORY_FILE);
}

function readMemoryFile(sessionDir: string): MemoryFile {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(coverageMemoryPath(sessionDir), "utf-8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MemoryFile;
  } catch {
    return {};
  }
}

/**
 * What earlier calls recorded for this review. Empty for a first call, for a
 * sessionless synthesize, and for an unreadable file -- all three are the same
 * statement: nothing is known, so nothing is held against this round.
 */
export function readCoverageMemory(
  sessionDir: string | undefined,
  reviewId: string,
): LensCoverageMemory {
  if (!sessionDir) return {};
  const forReview = readMemoryFile(sessionDir)[reviewId];
  if (!forReview || typeof forReview !== "object") return {};
  return forReview;
}

/**
 * Fold this round's coverage into the memory for this review.
 *
 * `everSkipped` only ever accumulates: a lens that skipped once has skipped,
 * whatever it submits afterwards, and that is precisely what makes a later
 * zero-finding `ok` readable as a relabel. The recorded `basis` is the one the
 * VERDICT carried, not the one this harness proposed, so a basis the server
 * demoted is what a later call is held to.
 *
 * Other reviews' records in the same file are preserved: one session runs many
 * reviews and a write must not be a truncation.
 */
export function updateCoverageMemory(
  sessionDir: string | undefined,
  reviewId: string,
  coverage: readonly LensCoverageEntry[],
): void {
  if (!sessionDir) return;
  try {
    const file = readMemoryFile(sessionDir);
    const prior = file[reviewId] ?? {};
    const next: Record<string, LensCoverageRecord> = { ...prior };
    for (const entry of coverage) {
      const before = prior[entry.lensId];
      const everSkipped = before?.everSkipped === true || entry.status === "skipped";
      const basis = entry.basis ?? before?.basis;
      next[entry.lensId] = {
        everSkipped,
        ...(basis === undefined ? {} : { basis }),
      };
    }
    file[reviewId] = next;
    mkdirSync(telemetryDirPath(sessionDir), { recursive: true });
    writeFileSync(coverageMemoryPath(sessionDir), JSON.stringify(file, null, 2));
  } catch {
    // Best effort. A lost write costs the next call its cross-call checks; it
    // can never produce a WRONG verdict, only a less suspicious one.
  }
}
