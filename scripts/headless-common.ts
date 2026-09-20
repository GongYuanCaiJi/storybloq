/**
 * Shared primitives for the headless `claude -p` runners (T-498 5c in
 * behavioral-gate-run.ts, T-525 continuity in continuity-run.ts). Extracted so
 * the two runners cannot drift on the parts that must not drift: which env
 * vars divert billing away from the subscription, how a killed session is
 * classified, and how a record reaches disk.
 */
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Env vars that would divert auth away from the authorized subscription
 * path (API key, or a third-party provider such as Bedrock/Vertex). This
 * list is a disclosed best effort, not an exhaustive guarantee.
 */
export const ALTERNATE_AUTH_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/** Refuses to proceed if the PARENT process's own environment already has an alternate-auth variable set. */
export function assertSubscriptionAuthOnly(env: NodeJS.ProcessEnv = process.env, label = "headless run"): void {
  const present = ALTERNATE_AUTH_ENV_VARS.filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `${label}: refusing to start -- subscription auth is required, but these env vars are set: ${present.join(", ")}. Unset them (they would divert billing away from the authorized subscription path) before running.`,
    );
  }
}

/** Node's setTimeout silently fires almost immediately above this (a 32-bit signed ms count). */
export const MAX_TIMER_MS = 2_147_483_647;

export function assertValidTimerMs(value: number, label: string, prefix = "headless run"): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${prefix}: ${label} must be a positive integer <= ${MAX_TIMER_MS}ms, got ${value}`);
  }
}

/**
 * "timeout" is our own SIGTERM-then-SIGKILL escalation. "external-kill" is an
 * unrequested SIGKILL we did not send -- most plausibly the OS's OOM killer,
 * but SIGKILL alone cannot prove that, so it is labelled honestly.
 */
export type SpawnKillKind = "timeout" | "external-kill";

export class SessionKilledError extends Error {
  constructor(
    public readonly kind: SpawnKillKind,
    message: string,
  ) {
    super(message);
  }
}

export class RecordPersistenceError extends Error {}

/** Temp file, fsync, rename into place, best-effort directory fsync. */
export async function writeAtomic(path: string, contents: string | Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best effort only -- not every filesystem supports fsync on a directory.
  }
}
