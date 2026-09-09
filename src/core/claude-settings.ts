/**
 * T-499: the ONE reader for Claude Code's `autoCompactWindow` setting.
 *
 * Claude Code merges settings from several files; for this one key the order
 * that matters is user < project < project-local, last DEFINED wins. Managed
 * (policy) settings live outside the user's reach and are not read: a value
 * set only there reports as ABSENT, and the capture records that honestly
 * rather than guessing a window.
 *
 * Every read is bounded and non-blocking (`readBoundedFile`: realpath, then
 * O_NOFOLLOW on the resolved target). A malformed file is skipped, not fatal:
 * a syntax error in `settings.local.json` must not erase a value the user
 * set at the user level.
 *
 * WHEN this is read matters more than how: Claude Code takes the value at
 * PROCESS start, so the capture path (`session intel-start`) reads it once
 * per process era and never again for that era. Nothing else should call
 * this on a hot path.
 */

import { join } from "node:path";
import { readBoundedFile } from "./limit-config.js";
import { defaultSettingsPath } from "./hook-migration.js";

export type AutoCompactWindowSource = "user" | "project" | "local";

export interface AutoCompactWindowReading {
  readonly value: number;
  readonly source: AutoCompactWindowSource;
}

/**
 * Sanity bounds on the setting itself. A window under 10k tokens or over 10M
 * is not a value Claude Code would honour, and a nonsense value must not
 * become a high-confidence ceiling.
 */
export const AUTO_COMPACT_WINDOW_BOUNDS = { min: 10_000, max: 10_000_000 } as const;

const SETTINGS_MAX_BYTES = 1024 * 1024;

function readWindowFrom(path: string): number | null {
  const body = readBoundedFile(path, SETTINGS_MAX_BYTES);
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).autoCompactWindow;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < AUTO_COMPACT_WINDOW_BOUNDS.min || value > AUTO_COMPACT_WINDOW_BOUNDS.max) return null;
  return value;
}

/** The three layers, lowest precedence first. Exported so a test can name them. */
export function autoCompactWindowLayers(
  projectRoot: string,
  userSettingsPath: string = defaultSettingsPath(),
): ReadonlyArray<{ readonly source: AutoCompactWindowSource; readonly path: string }> {
  return [
    { source: "user", path: userSettingsPath },
    { source: "project", path: join(projectRoot, ".claude", "settings.json") },
    { source: "local", path: join(projectRoot, ".claude", "settings.local.json") },
  ];
}

/**
 * Null means "no layer defines a valid value" -- the caller stores
 * `captureKind: "absent"`, never a default.
 */
export function readAutoCompactWindow(
  projectRoot: string,
  userSettingsPath?: string,
): AutoCompactWindowReading | null {
  let reading: AutoCompactWindowReading | null = null;
  for (const layer of autoCompactWindowLayers(projectRoot, userSettingsPath)) {
    const value = readWindowFrom(layer.path);
    if (value !== null) reading = { value, source: layer.source };
  }
  return reading;
}
