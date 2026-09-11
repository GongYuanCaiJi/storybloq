/**
 * T-502 test seam: a HealthDeps built from plain data.
 *
 * Every check is a pure function of these, so a fixture is a file map plus a
 * handful of stubs -- no network, no spawn, no writable HOME. The default
 * adapters get their own test (deps.test.ts) against a real isolated HOME,
 * which is the only place the syscalls are exercised.
 */

import { vi } from "vitest";
import { resolveSessionIntelConfig } from "../../../src/core/session-intel/config.js";
import type { SkillTargetInfo } from "../../../src/core/skill-version-marker.js";
import type {
  HealthCheckConfig,
  HealthContext,
  HealthDeps,
  HealthMarkerRead,
  HealthRead,
  HealthRun,
} from "../../../src/core/health/types.js";
import { HEALTH_CHECK_IDS } from "../../../src/core/health/types.js";

export const HOME = "/home/tester";
export const PROJECT = "/repo/app";

/** A file map: string content, or an explicit three-valued reading. */
export type FileMap = Record<string, string | HealthRead>;

export interface StubOptions {
  files?: FileMap;
  readFile?: HealthDeps["readFile"];
  run?: (cmd: string, args: readonly string[], timeoutMs: number) => HealthRun;
  now?: () => number;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: string;
  settings?: HealthDeps["settings"];
  callerSample?: HealthDeps["callerSample"];
  sessionIntel?: Record<string, unknown> | null;
  versionCache?: Partial<HealthDeps["versionCache"]>;
  skillMarker?: Partial<HealthDeps["skillMarker"]>;
  globalConfig?: HealthDeps["globalConfig"];
}

export function stubDeps(opts: StubOptions = {}): HealthDeps {
  const files = opts.files ?? {};
  return {
    readFile: opts.readFile ?? ((path) => {
      const entry = files[path];
      if (entry === undefined) return { kind: "absent" };
      return typeof entry === "string" ? { kind: "ok", text: entry } : entry;
    }),
    run: opts.run ?? (() => ({ kind: "enoent" })),
    now: opts.now ?? (() => 1_000),
    env: opts.env ?? {},
    homeDir: opts.homeDir ?? HOME,
    platform: opts.platform ?? "darwin",
    settings: opts.settings ?? { autoCompactWindow: () => ({ layers: [] }) },
    callerSample: opts.callerSample ?? (() => null),
    sessionIntelConfig: () => resolveSessionIntelConfig(opts.sessionIntel ?? null),
    versionCache: {
      read: opts.versionCache?.read ?? (() => null),
      refresh: opts.versionCache?.refresh ?? (async () => null),
    },
    skillMarker: {
      targets: opts.skillMarker?.targets ?? (() => []),
      installed: opts.skillMarker?.installed ?? (() => false),
      marker: opts.skillMarker?.marker ?? ((): HealthMarkerRead => ({ kind: "absent" })),
    },
    globalConfig: opts.globalConfig ?? (() => null),
  };
}

export function allChecksOn(): HealthCheckConfig {
  const checks = {} as Record<(typeof HEALTH_CHECK_IDS)[number], boolean>;
  for (const id of HEALTH_CHECK_IDS) checks[id] = true;
  return { enabled: true, checks };
}

export function ctxFor(over: Partial<HealthContext> = {}): HealthContext {
  return {
    ledgerRoot: "/repo",
    projectDir: PROJECT,
    cliVersion: "1.14.0",
    client: "claude",
    config: allChecksOn(),
    deadline: 6_000,
    ...over,
  };
}

export function skillTarget(over: Partial<SkillTargetInfo> = {}): SkillTargetInfo {
  return {
    id: "claude",
    client: "claude",
    dir: `${HOME}/.claude/skills/story`,
    displayPath: "~/.claude/skills/story/",
    ...over,
  };
}

/** A spawn stub that records how it was called. */
export function runStub(result: HealthRun) {
  return vi.fn((_cmd: string, _args: readonly string[], _timeoutMs: number) => result);
}
