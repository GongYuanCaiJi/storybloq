import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, existsSync, truncateSync, appendFileSync, utimesSync, chmodSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fault-injection seam on the presence write, test-side only: `beforeMutate`
 * runs after the lock is held and before the mutation callback (a PreCompact
 * racing the lock); `failWrite` runs the mutation callback and then reports
 * the write as failed (the callback's side effects happen, the record does
 * not change). Both are one-shot.
 */
const inject: { beforeMutate: (() => void) | null; failWrite: boolean } = { beforeMutate: null, failWrite: false };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    const before = inject.beforeMutate;
    const fail = inject.failWrite;
    inject.beforeMutate = null;
    inject.failWrite = false;
    if (!before && !fail) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    let sawWrite = false;
    const outcome = mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, (base, nowIso) => {
      before?.();
      const next = mutate(base, nowIso);
      if (fail) { sawWrite = true; return base; } // record left as it was
      return next;
    }, now);
    return fail && sawWrite && outcome.status === "written" ? { status: "skipped-write-failed" } : outcome;
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});
import {
  PENDING_MAX_LISTED,
  PENDING_SUBDIR,
  applyAssumedReset,
  applyBoundaryReset,
  judgeSample,
  markCompactPending,
  persistSample,
  readPresenceRecord,
  reconcileIntel,
  reconcileUnderLock,
  resolveCallerBinding,
  stampHandover,
} from "../../src/core/session-intel/presence-bridge.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { computeSample } from "../../src/core/session-intel/sampler.js";
import { scanTail } from "../../src/core/session-intel/transcript-scan.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../src/presence/session-intel-fields.js";
import { presenceFileBase } from "../../src/presence/types.js";
import type { CeilingResolution, TokenPressureSample } from "../../src/core/session-intel/types.js";
import { SID, assistantRecord, boundaryRecord, growingSession, writeTranscript } from "./session-intel-fixtures.js";

const cfg = resolveSessionIntelConfig(null);
const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-bridge-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(root: string, intel: Partial<SessionIntelPresence>, sessionId = SID): void {
  const r = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "test", (base) => ({ ...base, sessionIntel: { ...emptySessionIntel(), ...intel } }));
  expect(r.status).toBe("written");
}

const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;

function ceiling(): CeilingResolution {
  return { ceiling: 417_737, source: "setting", confidence: "high", sampleCount: 0, independentSessions: 0, effectiveSampleWindow: 0, basis: "t", conflict: null, autoCompactWindowAtStart: 450_000, captureKind: "startup", nativeWindow: null, highWaterMark: null };
}

function sampleFor(path: string, era: string | null, revisionSeen: number | null, record: SessionIntelPresence | null = null): TokenPressureSample {
  const scan = scanTail({ path, sessionId: SID, era, revisionSeen, epochSince: null })!;
  return computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record });
}

describe("pure resets", () => {
  const base: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2", revision: 3, lastSample: null, handoverWrittenAt: at(5), tokensAtHandover: 100, handoverBoundaryAt: null };

  it("applyBoundaryReset: newer boundary bumps revision, sets epoch, clears the sample; handover before ts cleared, after ts migrated; idempotent", () => {
    const cleared = applyBoundaryReset(base, at(6));
    expect(cleared).toMatchObject({ lastBoundaryAt: at(6), epoch: { kind: "observed", at: at(6) }, revision: 4, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null });
    const migrated = applyBoundaryReset(base, at(4));
    expect(migrated).toMatchObject({ handoverWrittenAt: at(5), tokensAtHandover: 100, handoverBoundaryAt: at(4), revision: 4 });
    expect(applyBoundaryReset(cleared, at(6))).toBe(cleared);
    expect(applyBoundaryReset(cleared, at(3))).toBe(cleared);
  });

  it("applyAssumedReset: assumed epoch, everything from before cleared including a later handover", () => {
    const r = applyAssumedReset(base, at(4));
    expect(r).toMatchObject({ lastBoundaryAt: at(4), epoch: { kind: "assumed", at: at(4) }, revision: 4, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null });
    expect(applyAssumedReset(r, at(4))).toBe(r);
  });
});

describe("reconcileIntel (pure classification)", () => {
  const file = (name: string, event: { eventId: string; era: string | null; at: string } | null, mtimeMs = T0) => ({ name, path: `/p/${name}`, event, mtimeMs });
  const intel: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2" };

  it("a pending at or before the newest boundary is resolved; a young one remains (incomplete); an old one expires to an assumed identity", () => {
    const now = T0 + 10 * 60_000;
    const listing = { complete: true, files: [file("a", { eventId: "a", era: "1:2", at: at(1) }), file("b", { eventId: "b", era: "1:2", at: at(9) })] };
    const r = reconcileIntel(intel, { timestamp: at(2), trigger: "auto", preTokens: 1, postTokens: 1 }, listing, cfg, now);
    expect(r.intel.lastBoundaryAt).toBe(at(2));
    expect(r.unlink).toEqual(["/p/a"]);
    expect(r.remaining).toBe(1);
    expect(r.status).toBe("incomplete");
    const later = reconcileIntel(intel, null, { complete: true, files: [file("b", { eventId: "b", era: "1:2", at: at(1) })] }, cfg, now);
    expect(later.intel.epoch).toEqual({ kind: "assumed", at: at(1) });
    expect(later.unlink).toEqual(["/p/b"]);
    expect(later.status).toBe("complete");
  });

  it("unparsable: pending while young, unlinked once past the TTL; an incomplete listing is never complete", () => {
    const now = T0 + 10 * 60_000;
    const young = reconcileIntel(intel, null, { complete: true, files: [file("x", null, now - 1000)] }, cfg, now);
    expect(young).toMatchObject({ remaining: 1, status: "incomplete", unlink: [] });
    const old = reconcileIntel(intel, null, { complete: true, files: [file("x", null, T0)] }, cfg, now);
    expect(old).toMatchObject({ remaining: 0, status: "complete", unlink: ["/p/x"] });
    expect(reconcileIntel(intel, null, { complete: false, files: [] }, cfg, now).status).toBe("incomplete");
  });

  it("era isolation: a null-era or foreign-era pending is stale cleanup, never blocking or resetting the current era", () => {
    const now = T0 + 10 * 60_000;
    const listing = { complete: true, files: [file("n", { eventId: "n", era: null, at: at(1) }), file("f", { eventId: "f", era: "7:7", at: at(1) })] };
    const r = reconcileIntel(intel, null, listing, cfg, now);
    expect(r.intel).toBe(intel);
    expect(r.unlink.sort()).toEqual(["/p/f", "/p/n"]);
    expect(r).toMatchObject({ remaining: 0, status: "complete" });
    // A record with no era cannot be blocked by anything either.
    const noEra = reconcileIntel({ ...intel, era: null }, null, { complete: true, files: [file("x", { eventId: "x", era: "1:2", at: at(9) })] }, cfg, now);
    expect(noEra).toMatchObject({ remaining: 0, status: "complete", unlink: ["/p/x"] });
  });

  it("a real boundary on top of an assumed identity resets normally", () => {
    const assumed = applyAssumedReset(intel, at(1));
    const r = reconcileIntel(assumed, { timestamp: at(2), trigger: "auto", preTokens: 1, postTokens: 1 }, { complete: true, files: [] }, cfg, T0);
    expect(r.intel.epoch).toEqual({ kind: "observed", at: at(2) });
    expect(r.intel.revision).toBe(assumed.revision + 1);
  });
});

describe("pending files and reconcileUnderLock", () => {
  it("markCompactPending publishes atomically, accepts same-content EEXIST, refuses different content, leaves no tmp", () => {
    withRoot((root) => {
      const ev = { eventId: "e1", era: "1:2", at: at(1) };
      expect(markCompactPending(root, SID, ev)).toBe(true);
      expect(markCompactPending(root, SID, ev)).toBe(true);
      expect(markCompactPending(root, SID, { ...ev, era: "9:9" })).toBe(false);
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(readdirSync(dir)).toHaveLength(1);
      expect(readdirSync(dir)[0]).toMatch(/\.json$/);
    });
  });

  it("writes the record FIRST, then unlinks resolved files; a stale .tmp is removed; 33 expired files drain 32 then the rest", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < PENDING_MAX_LISTED + 1; i++) markCompactPending(root, SID, { eventId: `e${String(i).padStart(2, "0")}`, era: "1:2", at: at(i) });
      const stale = join(dir, ".tmp-dead");
      writeFileSync(stale, "{");
      utimesSync(stale, (T0 - 1e6) / 1000, (T0 - 1e6) / 1000);
      const now = T0 + 60 * 60_000; // every pending is past the 5 min TTL
      const r1 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r1.status).toBe("incomplete");
      expect(existsSync(stale)).toBe(false);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(intelOf(root).epoch).toEqual({ kind: "assumed", at: at(PENDING_MAX_LISTED - 1) });
      const r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r2.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).epoch).toEqual({ kind: "assumed", at: at(PENDING_MAX_LISTED) });
    });
  });

  it("write-before-unlink: when the record write FAILS after the mutation ran, every pending file and the record survive untouched", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < 3; i++) markCompactPending(root, SID, { eventId: `e${i}`, era: "1:2", at: at(i) });
      const before = readPresenceRecord(root, SID);
      const now = T0 + 60 * 60_000; // all expired: the mutation computes three resets and three unlinks
      inject.failWrite = true;
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.enrichment?.status).toBe("skipped-write-failed");
      expect(r.status).toBe("incomplete");
      expect(readdirSync(dir).sort()).toHaveLength(3); // deletion was permitted; it was never attempted
      expect(readPresenceRecord(root, SID)).toEqual(before);
      // The next pass, with the write working, does the whole job.
      const r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r2.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).revision).toBe(3);
    });
  });

  it("a pending directory created and published while the lock was awaited is seen by reconciliation and by persistence (no cached absence)", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(existsSync(dir)).toBe(false);
      inject.beforeMutate = () => { expect(markCompactPending(root, SID, { eventId: "race", era: "1:2", at: at(1) })).toBe(true); };
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now: T0 + 2 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("incomplete");
      expect(r.reason).toMatch(/pending/);
      rmSync(dir, { recursive: true });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(2, 1, 1));
      const s = sampleFor(path, "1:2", intelOf(root).revision);
      inject.beforeMutate = () => { expect(markCompactPending(root, SID, { eventId: "race2", era: "1:2", at: at(3) })).toBe(true); };
      const out = persistSample({ root, sessionId: SID, sample: s, transcriptPath: path, cfg, now: T0 + 4 * 60_000, recompute: () => s });
      expect(out).toMatchObject({ status: "rejected", reason: expect.stringMatching(/pending/) });
      expect(intelOf(root).lastSample).toBeNull();
    });
  });

  it("an interrupted cleanup after a successful write is repaired on retry without another bump; a busy lock leaves everything", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < 3; i++) markCompactPending(root, SID, { eventId: `e${i}`, era: "1:2", at: at(i) });
      const now = T0 + 60 * 60_000; // all expired
      // 1. Lock held: never reaches the write, nothing unlinked, record untouched.
      const lock = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.lock`);
      mkdirSync(lock);
      try {
        const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, 0);
        expect(r.enrichment?.status).toBe("skipped-lock-busy");
      } finally {
        rmSync(lock, { recursive: true });
      }
      expect(readdirSync(dir)).toHaveLength(3);
      expect(intelOf(root).revision).toBe(0);
      // 2. Record write succeeds, cleanup is interrupted (directory made unwritable).
      chmodSync(dir, 0o500);
      let r2;
      try {
        r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(r2.enrichment?.status).toBe("written");
      // Three expired events, each newer than the last: three assumed resets, three bumps.
      expect(intelOf(root)).toMatchObject({ revision: 3, epoch: { kind: "assumed", at: at(2) } });
      expect(readdirSync(dir)).toHaveLength(3); // the write landed, the unlinks did not
      // 3. Retry: resolved by `at <= lastBoundaryAt`, unlinked, no further bump.
      const r3 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r3.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).revision).toBe(3);
    });
  });

  it("a pending resolved by the tail's boundary with no SessionStart ever arriving; a delayed second pass is a no-op", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      markCompactPending(root, SID, { eventId: "e", era: "1:2", at: at(1) });
      const b = { timestamp: at(2), trigger: "auto" as const, preTokens: 1, postTokens: 1 };
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [b], transcriptPath: null, source: "other", now: T0 + 3 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("complete");
      const rev = intelOf(root).revision;
      expect(intelOf(root).lastBoundaryAt).toBe(at(2));
      reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [b], transcriptPath: null, source: "compact", now: T0 + 4 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(intelOf(root).revision).toBe(rev);
    });
  });

  it("a boundary beyond the tail is found by the backward scan when a pending exists or the source is compact", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const lines = [boundaryRecord({ ts: at(1), pre: 400_000 }), ...growingSession(3000, 1_000, 100)];
      const path = writeTranscript(join(root, "projects"), "p", SID, lines);
      expect(scanTail({ path, sessionId: SID, era: null, revisionSeen: null, epochSince: null })!.boundaries).toHaveLength(0);
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: path, source: "compact", now: T0 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("complete");
      expect(intelOf(root).lastBoundaryAt).toBe(at(1));
    });
  });

  it("a busy lock is incomplete for a sampler (budget 0) and leaves the file for the next entry point", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      markCompactPending(root, SID, { eventId: "e", era: "1:2", at: at(1) });
      const lock = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.lock`);
      mkdirSync(lock);
      try {
        const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now: T0 }, 0);
        expect(r.status).toBe("incomplete");
        expect(r.enrichment?.status).toBe("skipped-lock-busy");
      } finally {
        rmSync(lock, { recursive: true });
      }
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(readdirSync(dir)).toHaveLength(1);
    });
  });
});

describe("judgeSample (persistence rule)", () => {
  const obs = { era: "1:2", incarnation: "1:1", sizeAtOpen: 100, consumedOffset: 100, anchor: { offset: 100, sha256: "a".repeat(64) }, authoritative: true, revisionSeen: 0, lastRecordTimestamp: null, epoch: { kind: "unobserved" as const } };
  const s = (o: Partial<typeof obs>) => ({ observation: { ...obs, ...o } }) as unknown as TokenPressureSample;
  const intel: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2", revision: 0, incarnation: "1:1", consumedOffset: 50, baselineAnchor: { offset: 50, sha256: "b".repeat(64) } };
  const ok = { incarnation: "1:1", size: 100, baselineOk: true, incomingOk: true };

  it("accepts only when every rule holds", () => {
    expect(judgeSample(intel, s({}), ok).verdict).toBe("accept");
    expect(judgeSample(intel, s({ era: null }), ok).reason).toMatch(/era/);
    expect(judgeSample({ ...intel, era: null }, s({}), ok).reason).toMatch(/era/);
    expect(judgeSample(intel, s({ era: "9:9" }), ok).reason).toMatch(/era/);
    expect(judgeSample(intel, s({ authoritative: false }), ok).reason).toMatch(/non-authoritative/);
    expect(judgeSample({ ...intel, revision: 1 }, s({}), ok).reason).toMatch(/stale revision/);
    expect(judgeSample(intel, s({}), { ...ok, incarnation: "2:2" }).reason).toMatch(/replaced/);
    expect(judgeSample(intel, s({}), { ...ok, incarnation: null, size: null }).reason).toMatch(/unreadable/);
  });

  it("baseline broken bumps the revision and rejects; incoming broken likewise; older offset rejects without a bump", () => {
    expect(judgeSample(intel, s({}), { ...ok, size: 40 })).toMatchObject({ verdict: "reject", bumpRevision: true, reason: expect.stringMatching(/baseline/) });
    expect(judgeSample(intel, s({}), { ...ok, baselineOk: false })).toMatchObject({ verdict: "reject", bumpRevision: true });
    expect(judgeSample(intel, s({}), { ...ok, incomingOk: false })).toMatchObject({ verdict: "reject", bumpRevision: true, reason: expect.stringMatching(/observation anchor/) });
    expect(judgeSample(intel, s({ consumedOffset: 90, sizeAtOpen: 90 }), { ...ok, size: 85 })).toMatchObject({ verdict: "reject", bumpRevision: true });
    expect(judgeSample(intel, s({ consumedOffset: 40, sizeAtOpen: 40 }), ok)).toMatchObject({ verdict: "reject", bumpRevision: false, reason: expect.stringMatching(/older/) });
    // Baseline check only applies to the same incarnation the record knows.
    expect(judgeSample({ ...intel, incarnation: "0:0" }, s({}), { ...ok, size: 40, baselineOk: false }).reason).toMatch(/observation anchor|older/);
  });
});

describe("persistSample end to end", () => {
  it("accepts a fresh sample, drops an older-offset one, detects truncation with a revision bump, then accepts the next", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      const first = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: first, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      const after = intelOf(root);
      expect(after.consumedOffset).toBe(first.observation.consumedOffset);
      expect(after.baselineAnchor).toEqual(first.observation.anchor);
      expect(after.lastSample?.contextTokens).toBe(first.contextTokens);
      // Newer bytes arrive; an older Stop sample (computed before them) is dropped by offset.
      const older = first;
      appendFileSync(path, assistantRecord({ ts: at(9), read: 5_000 }) + "\n");
      const newer = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: newer, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      expect(persistSample({ root, sessionId: SID, sample: older, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/older/) });
      // Truncate below the baseline, regrow: the detecting sample is rejected with a bump, the next is accepted.
      truncateSync(path, 10);
      appendFileSync(path, growingSession(2, 5, 1).join("\n") + "\n");
      const detecting = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: detecting, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/baseline/) });
      expect(intelOf(root).revision).toBe(1);
      expect(intelOf(root).baselineAnchor).toBeNull();
      const next = sampleFor(path, "1:2", 1);
      expect(persistSample({ root, sessionId: SID, sample: next, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
    });
  });

  it("truncation between read and persist (file shorter than the sample's own offset) is rejected by the incoming check", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      const s = sampleFor(path, "1:2", 0);
      truncateSync(path, s.observation.consumedOffset - 5);
      expect(persistSample({ root, sessionId: SID, sample: s, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/observation anchor/) });
      expect(intelOf(root).revision).toBe(1);
    });
  });

  it("a handover stamped between compute and persist is honoured: suppression is recomputed on the SAME validated scan and the persisted observation is the one that passed", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const tokens = Math.ceil(0.85 * 417_737) - 25_000;
      const path = writeTranscript(join(root, "projects"), "p", SID, [assistantRecord({ ts: at(0), read: tokens - 2 })]);
      const scan = scanTail({ path, sessionId: SID, era: "1:2", revisionSeen: 0, epochSince: null })!;
      const computed = computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record: null });
      expect(computed.state).toBe("imperative");
      expect(stampHandover(root, SID, "1:2", tokens, T0).status).toBe("written");
      // Production recomputation reuses the validated scan; only suppression changes.
      const recompute = (rec: SessionIntelPresence) => computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record: rec });
      const out = persistSample({ root, sessionId: SID, sample: computed, transcriptPath: path, cfg, now: T0, recompute });
      expect(out.status).toBe("accepted");
      expect(intelOf(root).lastSample).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
      expect(intelOf(root).lastSample?.observation).toEqual(computed.observation);
      expect(intelOf(root).handoverBoundaryAt).toBeNull();
    });
  });

  it("stampHandover refuses an ended record, a null caller era, an era mismatch and a record without a subtree (never creates one)", () => {
    withRoot((root) => {
      expect(stampHandover(root, SID, "1:2", 1, T0)).toMatchObject({ status: "refused" });
      expect(readPresenceRecord(root, SID)?.sessionIntel?.handoverWrittenAt ?? null).toBeNull();
      seed(root, { era: "1:2" });
      expect(stampHandover(root, SID, null, 1, T0)).toMatchObject({ status: "refused" });
      expect(stampHandover(root, SID, "9:9", 1, T0)).toMatchObject({ status: "refused", reason: expect.stringMatching(/era/) });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(stampHandover(root, SID, "1:2", 1, T0)).toMatchObject({ status: "refused", reason: expect.stringMatching(/ended/) });
      expect(intelOf(root).handoverWrittenAt).toBeNull();
    });
  });

  it("era mismatch, null era, a non-authoritative scan, an ended record and a pending compaction never persist; the stored sample and baseline stay", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(2, 1, 1));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "9:9", 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("rejected");
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, null, 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("rejected");
      expect(intelOf(root).lastSample).toBeNull();
      // Establish a baseline, then try to replace it with a partial scan of the same era and revision.
      const good = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: good, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      const stored = intelOf(root);
      const partial = { ...good, observation: { ...good.observation, authoritative: false } };
      expect(persistSample({ root, sessionId: SID, sample: partial, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/non-authoritative/) });
      expect(intelOf(root)).toEqual(stored);
      // A compaction published AFTER reconciliation and BEFORE persistence is caught under the lock.
      markCompactPending(root, SID, { eventId: "p", era: "1:2", at: at(1) });
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0 + 2 * 60_000, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/pending/) });
      expect(intelOf(root)).toEqual(stored);
      rmSync(join(root, ".story", "telemetry", PENDING_SUBDIR), { recursive: true });
      // SessionEnd between binding and the write.
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/ended/) });
      expect(intelOf(root).lastSample).toEqual(stored.lastSample);
    });
  });

  it("a replacement whose baseline prefix matches the old file is rejected as replaced, not validated by the surviving baseline", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      // The sample is computed on the old inode; the file is then replaced by a
      // copy with identical bytes plus a new record (the baseline prefix matches).
      const old = sampleFor(path, "1:2", 0);
      const copy = `${path}.new`;
      writeFileSync(copy, readFileSync(path));
      appendFileSync(copy, assistantRecord({ ts: at(9), read: 5_000 }) + "\n");
      renameSync(copy, path);
      expect(persistSample({ root, sessionId: SID, sample: old, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/replaced/) });
    });
  });
});

describe("resolveCallerBinding", () => {
  const saved = { ...process.env };
  beforeEach(() => { processEra.reset(); });
  afterEach(() => {
    for (const k of ["CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "STORYBLOQ_CLIENT"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    processEra.reset();
  });

  it("binds only with a live record whose era equals the caller's live era; ended id, era mismatch, null era, codex all unbound", () => {
    withRoot((root) => {
      process.env.CLAUDE_CODE_SESSION_ID = SID;
      process.env.CLAUDE_PID = String(process.pid);
      delete process.env.STORYBLOQ_CLIENT;
      const era = processEra.current()!.id;
      expect(resolveCallerBinding(root).reason).toMatch(/no presence record/);
      seed(root, { era: "9:9" });
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, reason: expect.stringMatching(/differs/) });
      seed(root, { era });
      expect(resolveCallerBinding(root)).toMatchObject({ bound: true, sessionId: SID, era, check: "live" });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, reason: expect.stringMatching(/ended/) });
      process.env.STORYBLOQ_CLIENT = "codex";
      expect(resolveCallerBinding(root).reason).toMatch(/not Claude/);
      delete process.env.STORYBLOQ_CLIENT;
      delete process.env.CLAUDE_PID;
      processEra.reset();
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null }));
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, era: null, reason: expect.stringMatching(/era unknown/) });
      expect(resolveCallerBinding(null).reason).toMatch(/no project/);
    });
  });
});
