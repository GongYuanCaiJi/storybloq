/**
 * T-502: the default `HealthDeps` adapters.
 *
 * This is the ONLY module in `core/health` that touches the real home
 * directory, environment, clock, platform or a subprocess. Everything else is
 * a pure function of its inputs, which is what makes the five checks
 * testable without a network, a spawn or a writable HOME -- and what makes
 * THIS module the one that has to be tested against a real (isolated) HOME,
 * because nothing else exercises the syscalls.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAutoCompactWindowDiagnostic } from "../claude-settings.js";
import { readBoundedFileDetailed } from "../limit-config.js";
import { isHealthCheckGloballyDisabled } from "../limit-ledger.js";
import { readPresenceRecord, resolveCallerBinding } from "../session-intel/presence-bridge.js";
import { readSessionIntelConfig, resolveSessionIntelConfig } from "../session-intel/config.js";
import { SKILL_MARKER_FILE, SKILL_MARKER_MAX_BYTES, skillTargets } from "../skill-version-marker.js";
import { readUpdateCacheSync, refreshUpdateCache } from "../update-check.js";
import type { HealthDeps, HealthMarkerRead, HealthRead, HealthRun } from "./types.js";

/**
 * Three-valued bounded read, delegating to the shared
 * `readBoundedFileDetailed` so `storybloq health` and Claude Code's settings
 * reader cannot drift on what "unreadable" means. The only thing added here
 * is the empty-file case: an empty document is content we read successfully
 * and cannot parse, which the JSON layer above turns into indeterminate,
 * rather than a file that is not there.
 */
export function readFileThreeValued(path: string, maxBytes: number): HealthRead {
  return readBoundedFileDetailed(path, maxBytes);
}

/**
 * A capped probe that distinguishes a missing binary from one that did not
 * answer, because "Codex is not installed" and "codex --version did not
 * answer" are different sentences and only one of them may be said when the
 * probe timed out.
 *
 * `killSignal: "SIGKILL"` is deliberate. `spawnSync`'s default SIGTERM waits
 * for the child to exit, so a wrapper that catches or ignores SIGTERM would
 * hold the whole command (and, on the MCP surface, the server's event loop)
 * past `timeoutMs`. The cap has to be enforceable, not advisory.
 *
 * Only ETIMEDOUT is a timeout. A child that dies on a signal of its own, or
 * hits the output buffer limit, is a FAILED probe: reporting it as a timeout
 * would put the wrong reason in front of the user.
 */
export function runBounded(cmd: string, args: readonly string[], timeoutMs: number): HealthRun {
  const result = spawnSync(cmd, [...args], {
    timeout: Math.max(1, timeoutMs),
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  });
  const code = (result.error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return { kind: "enoent" };
  if (code === "ETIMEDOUT") return { kind: "timeout" };
  if (result.error) return { kind: "failed", code: result.status ?? null };
  if (result.signal !== null) return { kind: "failed", code: null };
  if (result.status !== 0) return { kind: "failed", code: result.status ?? null };
  return { kind: "ok", stdout: result.stdout ?? "" };
}

export function defaultHealthDeps(opts: { ledgerRoot: string | null }): HealthDeps {
  return {
    readFile: readFileThreeValued,
    run: runBounded,
    now: () => Date.now(),
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
    settings: {
      autoCompactWindow: (projectDir) => readAutoCompactWindowDiagnostic(projectDir),
    },
    // STRICTLY read-only, and deliberately NOT `acquireCallerSample`: that
    // helper refreshes a stale sample through `sampleSession`, which PERSISTS
    // a new sample onto the caller's presence record. `storybloq health` is
    // on demand and repeatable, so it must observe session state without
    // touching it -- not merely avoid T-501's once-per-session stamp. A stale
    // or absent stored sample therefore yields null and the check falls back
    // to a window-only evaluation.
    // The interface hands every implementation the remaining budget; this one
    // does not need it, because a single bounded record read is not a
    // budgeted operation once the refresh is gone.
    callerSample: () => {
      const root = opts.ledgerRoot;
      if (root === null) return null;
      try {
        const binding = resolveCallerBinding(root);
        if (!binding.bound || !binding.sessionId) return null;
        const record = readPresenceRecord(binding.recordRoot ?? root, binding.sessionId);
        const sample = record?.sessionIntel?.lastSample;
        if (!sample) return null;
        // FRESHNESS, not just presence. Without this a `oneMillionFlag: true`
        // recorded before the user switched models would keep producing a
        // 1M-model advisory for a session that is no longer running one. The
        // window is sessionIntel's own `maxSampleAgeMs`, the same limit the
        // push path uses to decide a sample is too old to describe -- except
        // that where the push path refreshes, this one gives up.
        const age = Date.now() - Date.parse(sample.sampledAt);
        if (!Number.isFinite(age) || age < 0) return null;
        if (age > readSessionIntelConfig(root).maxSampleAgeMs) return null;
        const flag = sample.usageInput?.oneMillionFlag;
        return flag === undefined ? null : { oneMillionFlag: flag };
      } catch {
        return null;
      }
    },
    sessionIntelConfig: (ledgerRoot) =>
      ledgerRoot === null ? resolveSessionIntelConfig(null) : readSessionIntelConfig(ledgerRoot),
    versionCache: {
      read: (currentVersion) => readUpdateCacheSync(currentVersion),
      refresh: (o) => refreshUpdateCache(o),
    },
    skillMarker: {
      targets: () => skillTargets(),
      installed: (target) => fs.existsSync(join(target.dir, "SKILL.md")),
      marker: (target) => markerRead(join(target.dir, SKILL_MARKER_FILE)),
    },
    // The kill-switch predicate stays the single source of the rule (it sits
    // beside the limitResume and sessionIntel switches, where a reader looks
    // for them); this dep is the injection point that lets a test express the
    // switch as a plain object.
    globalConfig: () => (isHealthCheckGloballyDisabled() ? { healthCheck: { enabled: false } } : null),
  };
}

function markerRead(path: string): HealthMarkerRead {
  const raw = readFileThreeValued(path, SKILL_MARKER_MAX_BYTES);
  if (raw.kind === "absent") return { kind: "absent" };
  if (raw.kind === "indeterminate") return { kind: "indeterminate", reason: raw.reason };
  const text = raw.text.trim();
  return text.length > 0 ? { kind: "ok", value: text } : { kind: "absent" };
}
