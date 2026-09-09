import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_FILE,
  LEDGER_MAX_INPUT_BYTES,
  LEDGER_SUBDIR,
  ingestBoundaries,
  parseLedger,
  readLedger,
  trimLedger,
  type LedgerEntry,
} from "../../src/core/session-intel/boundary-ledger.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function entry(sessionId: string, minute: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { sessionId, era: "1:2", captureKind: "startup", timestamp: at(minute), trigger: "auto", preTokens: 417_000 + minute, postTokens: 30_000, autoCompactWindowAtStart: 450_000, ...over };
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-ledger-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("trimLedger", () => {
  it("dedupes by (sessionId, timestamp); an unclassified entry can gain an era but a classified one never changes", () => {
    const existing = [entry("a", 1, { era: null, captureKind: null }), entry("a", 2)];
    const incoming = [entry("a", 1), entry("a", 2, { era: "9:9" })];
    const r = trimLedger(existing, incoming, 20);
    expect(r.entries.find((e) => e.timestamp === at(1))!.era).toBe("1:2");
    expect(r.entries.find((e) => e.timestamp === at(2))!.era).toBe("1:2");
    expect(r.entries).toHaveLength(2);
  });

  it("keeps the newest perSession entries; an evicted entry re-ingested cannot displace a newer one", () => {
    const existing = [entry("a", 3), entry("a", 4), entry("a", 5)];
    const r = trimLedger(existing, [entry("a", 1)], 3);
    expect(r.entries.map((e) => e.timestamp)).toEqual([at(3), at(4), at(5)]);
    expect(r.windows.get("a")).toBe(3);
  });

  it("global cap is filled round-robin so a busy session cannot evict a quiet one", () => {
    const busy = Array.from({ length: 50 }, (_, i) => entry("busy", 100 + i));
    const quiet = [entry("quiet", 1)];
    const r = trimLedger([], [...busy, ...quiet], 50, 10);
    expect(r.entries).toHaveLength(10);
    expect(r.windows.get("quiet")).toBe(1);
    expect(r.windows.get("busy")).toBe(9);
    // Busy keeps its NEWEST nine.
    expect(r.entries.filter((e) => e.sessionId === "busy").map((e) => e.timestamp).sort()).toEqual(busy.slice(-9).map((e) => e.timestamp).sort());
  });

  it("with more sessions than the cap, the sessions with the oldest newest-boundary are evicted entirely, deterministically", () => {
    const incoming: LedgerEntry[] = [];
    for (let s = 0; s < 12; s++) incoming.push(entry(`s${String(s).padStart(2, "0")}`, s));
    const r = trimLedger([], incoming, 20, 10);
    expect(r.entries).toHaveLength(10);
    expect(r.evictedSessions).toEqual(["s01", "s00"]);
    expect(r.windows.has("s00")).toBe(false);
    expect(r.windows.get("s11")).toBe(1);
  });

  it("ties on newest boundary are broken by sessionId", () => {
    const r = trimLedger([], [entry("b", 1), entry("a", 1), entry("c", 1)], 20, 2);
    expect([...r.windows.keys()].sort()).toEqual(["a", "b"]);
    expect(r.evictedSessions).toEqual(["c"]);
  });
});

describe("ingestBoundaries / readLedger", () => {
  it("writes, dedupes on re-ingest, reports unchanged, and reads back typed entries", () => {
    withRoot((root) => {
      expect(ingestBoundaries(root, [], 20)).toBe("unchanged");
      expect(ingestBoundaries(root, [entry("a", 1), entry("a", 2)], 20)).toBe("written");
      expect(ingestBoundaries(root, [entry("a", 1)], 20)).toBe("unchanged");
      const read = readLedger(root);
      expect(read).toHaveLength(2);
      expect(read[0]).toEqual(entry("a", 1));
    });
  });

  it("refuses an oversize ledger before parsing (reads as empty), and tolerates garbage", () => {
    withRoot((root) => {
      const dir = join(root, ".story", "telemetry", LEDGER_SUBDIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, LEDGER_FILE), "[" + "1,".repeat(LEDGER_MAX_INPUT_BYTES) + "1]");
      expect(readLedger(root)).toEqual([]);
      writeFileSync(join(dir, LEDGER_FILE), "{bad");
      expect(readLedger(root)).toEqual([]);
      expect(parseLedger(JSON.stringify([{ sessionId: "a" }, { sessionId: "a", timestamp: at(1), trigger: "manual", preTokens: -1 }, { sessionId: "b", timestamp: at(1) }, { sessionId: "c", timestamp: at(1), trigger: "Auto" }]))).toEqual([
        { sessionId: "a", era: null, captureKind: null, timestamp: at(1), trigger: "manual", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
        { sessionId: "b", era: null, captureKind: null, timestamp: at(1), trigger: "unknown", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
        { sessionId: "c", era: null, captureKind: null, timestamp: at(1), trigger: "unknown", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
      ]);
    });
  });

  it("per-session retention equals the configured window", () => {
    withRoot((root) => {
      ingestBoundaries(root, Array.from({ length: 30 }, (_, i) => entry("a", i)), 7);
      const read = readLedger(root);
      expect(read).toHaveLength(7);
      expect(read.map((e) => e.timestamp)).toEqual(Array.from({ length: 7 }, (_, i) => at(23 + i)));
    });
  });
});
