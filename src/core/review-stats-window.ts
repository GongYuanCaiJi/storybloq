/**
 * T-495: the contract measurement window.
 *
 * WHY A WINDOW EXISTS AT ALL. Without one, every review verdict artifact this
 * repository already holds precedes the feature and becomes an exclusion, so
 * the first live run reports an exclusion rate above ninety percent and is
 * INVALID before it starts. The window says which rounds the week is about.
 *
 * It is IMMUTABLE by construction. `--open-window` refuses to run twice and
 * `--close-window` refuses to re-open, because a population that can be
 * re-based after the fact cannot support a threshold verdict about itself: the
 * verdict would describe whichever start time produced the nicer number.
 *
 * The window lives at the TOP LEVEL of `.story/config.json`, not under
 * `recipeOverrides`. That object is a plain `z.object` and strips undeclared
 * keys on parse, which is the seam `readBlockingPolicy` documents; the top
 * level is `.passthrough()`, and the key is declared besides, so it survives a
 * round trip either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, withProjectLock } from "./project-loader.js";

export interface ContractWindow {
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly baselineHash: string;
  readonly roots: readonly string[];
}

function configPath(projectRoot: string): string {
  return join(projectRoot, ".story", "config.json");
}

/**
 * Read the window, or null.
 *
 * A MALFORMED window reads as ABSENT, never as a partially usable one. Half a
 * window would let the reader select a population against a start time it
 * invented, and a verdict over an invented population is worse than no verdict:
 * the second says it does not know, the first does not.
 */
export function readContractWindow(projectRoot: string): ContractWindow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(projectRoot), "utf-8"));
  } catch {
    return null;
  }
  const cm = (raw as { contractMeasurement?: unknown } | null)?.contractMeasurement;
  if (cm === null || typeof cm !== "object") return null;
  const w = cm as Record<string, unknown>;
  if (typeof w.openedAt !== "string" || w.openedAt === "") return null;
  if (typeof w.baselineHash !== "string" || w.baselineHash === "") return null;
  if (!(w.closedAt === null || typeof w.closedAt === "string")) return null;
  if (!Array.isArray(w.roots) || !w.roots.every((r) => typeof r === "string")) return null;
  return {
    openedAt: w.openedAt,
    closedAt: w.closedAt === undefined ? null : (w.closedAt as string | null),
    baselineHash: w.baselineHash,
    roots: w.roots as readonly string[],
  };
}

export type OpenWindowResult =
  | { readonly ok: true; readonly window: ContractWindow }
  | { readonly ok: false; readonly reason: string };

/**
 * Open the window. Refuses when one is already recorded.
 *
 * The refusal is total: nothing is rewritten, not even `openedAt`. A refusal
 * that still moved the start time would re-base the population it was refusing
 * to re-base.
 *
 * UNDER THE PROJECT LOCK, and the whole read-modify-write is inside it. An
 * earlier draft did the check and the write unlocked and merely DISCLOSED the
 * race; Codex was right that a disclosure preserves neither the window's
 * immutability nor the rest of the file. Two openers could both see no window
 * and the second win, and worse, a concurrent config write by anything else
 * would be silently discarded by this one's read-modify-write.
 *
 * The write is ATOMIC (temp file, then rename) for the same reason: a direct
 * `writeFileSync` truncates config.json first, so a crash or a full disk
 * between truncate and write destroys the project's configuration while this
 * function reports only that opening failed.
 */
export type BaselineResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: string };

export async function openContractWindow(
  projectRoot: string,
  opts: {
    readonly roots: readonly string[];
    /**
     * Reads and validates the contract. EVALUATED INSIDE THE LOCK, and that is
     * the whole reason it is a callback rather than a value.
     *
     * A hash captured before the lock is acquired describes REVIEW.md as it was
     * BEFORE the wait. If the file changes while this command queues, the
     * window opens immutably against the old bytes with a later `openedAt`, and
     * every delivery of the contract that is actually in force then fails
     * baseline verification for the entire week. Codex found it in round 2,
     * after the lock itself had been added in response to round 1: taking a
     * lock does not help if the value it protects was read outside it.
     */
    readonly baseline: () => BaselineResult;
  },
): Promise<OpenWindowResult> {
  let outcome: OpenWindowResult = {
    ok: false,
    reason: "The project lock could not be taken, so no window was opened.",
  };
  try {
    await withProjectLock(projectRoot, { strict: false }, async () => {
      // READ INSIDE THE LOCK. Reading before taking it would reintroduce the
      // race the lock exists to close.
      const existing = readContractWindow(projectRoot);
      if (existing !== null) {
        outcome = {
          ok: false,
          reason:
            `A measurement window is already open (opened ${existing.openedAt}). Re-opening would `
            + "re-base the population after the fact, which is what makes a threshold verdict "
            + "about it meaningless.",
        };
        return;
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(
          readFileSync(configPath(projectRoot), "utf-8"),
        ) as Record<string, unknown>;
      } catch (err) {
        outcome = { ok: false, reason: `Could not read .story/config.json: ${String(err)}` };
        return;
      }
      // A `contractMeasurement` key that is present but unreadable is NOT an
      // absent window: overwriting it would discard a window whose shape this
      // build does not understand, which is the one destructive thing this
      // command can do.
      if (raw.contractMeasurement !== undefined) {
        outcome = {
          ok: false,
          reason:
            "`contractMeasurement` is already present in .story/config.json but could not be read "
            + "as a window. It is left untouched: overwriting it would discard a record this "
            + "build does not understand.",
        };
        return;
      }

      // Read and validated HERE, under the lock, so the recorded baseline is
      // the contract in force at the moment the window is created.
      const baseline = opts.baseline();
      if (!baseline.ok) {
        outcome = { ok: false, reason: baseline.reason };
        return;
      }

      const window: ContractWindow = {
        openedAt: new Date().toISOString(),
        closedAt: null,
        baselineHash: baseline.hash,
        roots: opts.roots,
      };
      try {
        await atomicWrite(
          configPath(projectRoot),
          `${JSON.stringify({ ...raw, contractMeasurement: window }, null, 2)}\n`,
        );
      } catch (err) {
        outcome = { ok: false, reason: `Could not write .story/config.json: ${String(err)}` };
        return;
      }
      outcome = { ok: true, window };
    });
  } catch (err) {
    return { ok: false, reason: `Could not take the project lock: ${String(err)}` };
  }
  return outcome;
}
