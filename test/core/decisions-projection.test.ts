/**
 * T-528 commit 0: the decisions projection module and its writer. RED at
 * d38bd676: `src/core/decisions-projection.ts` does not exist there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  CAPTURE_ATTEMPTS,
  LEDGER_REVISION_HEADER,
  PROJECTION_RESOLUTION_KINDS,
  computeDecisionsProjection,
  freshnessKind,
  hashPass,
  ledgerRevision,
  sha256Hex,
  type ProjectionDeps,
  type ProjectionMode,
  type RevisionEntry,
} from "../../src/core/decisions-projection.js";
import { serializeRulingLabels } from "../../src/core/decisions-labels.js";
import { formatDecisionsListing } from "../../src/core/decisions-listing.js";
import { loadRulingsSafe } from "../../src/core/ruling-loader.js";
import { buildCitationResolutionContext, buildSuccessorIndex, citationWarningText, lifecycleMapFor, resolveCitation, type UpwardBoard } from "../../src/core/ruling.js";
import { checkCapabilities, type CapabilityCheckReport } from "../../src/core/capability.js";
import { glossaryCatalog } from "../../src/core/glossary.js";
import { loadProject } from "../../src/core/project-loader.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { projectionPath, projectionTestHooks, writeDecisionsProjection } from "../../src/cli/commands/projection.js";
import type { Ruling } from "../../src/models/ruling.js";
import { hashTree } from "../../scripts/continuity-lib.js";
import { LABELS_OUT } from "../../scripts/export-labels.js";
import {
  FIXED_HEAD,
  PROJECTION_FIXTURES,
  PROJECTION_FIXTURE_DIR,
  SYN,
  buildSyntheticLedger,
  generateContinuityProjection,
} from "../../scripts/projection-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const CATALOGS = { capabilities: capabilityCatalog, glossary: glossaryCatalog };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ledger(opts: { pointer?: boolean; unreadable?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-projection-"));
  roots.push(root);
  buildSyntheticLedger(root, { pointer: opts.pointer ?? false, unreadable: opts.unreadable ?? false });
  return root;
}

function orchestrator(extra: Record<string, unknown>[] = []): UpwardBoard {
  const r = (id: string, supersedes: string | null): Record<string, unknown> => ({
    id, text: `orchestrator ${id}`, attribution: "owner-direct", recordedBy: { client: "claude", id: "t" },
    date: "2026-09-10", scopeTags: [], supersedes, createdAt: "2026-09-10T10:00:00.000Z",
  });
  const rulings = [r(SYN.orchOld, null), r(SYN.orchCurrent, SYN.orchOld), ...extra] as unknown as Ruling[];
  return { kind: "board", root: "/orchestrator", ctx: buildCitationResolutionContext(rulings, new Set(), "complete") };
}

function structuralCheck(root: string): ProjectionDeps["check"] {
  return (entries, state, options) => checkCapabilities(root, entries, state, { ...options, skipFreshness: true });
}

function deps(root: string, over: Partial<ProjectionDeps> = {}): ProjectionDeps {
  return {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
    cliVersion: "test",
    headCommit: async () => FIXED_HEAD,
    check: structuralCheck(root),
    upwardBoard: (p) => (p.ok || p.code !== "no-pointer" ? orchestrator() : undefined),
    ...over,
  };
}

type Resolution = { kind: string; message: string; upwardDependency: boolean; board?: string; target?: string; ids?: string[]; lifecycle?: string; reasons?: string[]; reason?: string };
type Projection = {
  ledgerRevision: string | null;
  rulings: { id: string; lifecycle: string; supersededBy: string[]; proposalsAgainst: string[]; citedBy: string[] }[];
  citations: { citedId: string; resolution: Resolution }[];
  capabilities: { id: string; effectiveStatus: string; freshness: { kind: string } }[];
  diagnostics: { file: string; reason: string }[];
  upwardBoard: { pointer: string; state: string };
};

async function projectionOf(root: string, mode: ProjectionMode = "structural", over: Partial<ProjectionDeps> = {}): Promise<Projection> {
  return (await computeDecisionsProjection(root, CATALOGS, mode, deps(root, over))).projection as unknown as Projection;
}

const res = (p: Projection, id: string): Resolution => p.citations.find((c) => c.citedId === id)!.resolution;

describe("ledger revision", () => {
  it("is sha256 over the header and sorted `<path>\\t<sha|->` lines, NFC, with an absent singleton kept", () => {
    const entries: RevisionEntry[] = [
      { path: "tickets/T-1.json", state: { kind: "ok", sha256: "b".repeat(64) } },
      { path: "config.json", state: { kind: "absent" } },
      { path: "rulings/Cafe\u0301.json", state: { kind: "ok", sha256: "a".repeat(64) } },
    ];
    const expected = sha256Hex(
      LEDGER_REVISION_HEADER + `config.json\t-\n` + `rulings/Caf\u00e9.json\t${"a".repeat(64)}\n` + `tickets/T-1.json\t${"b".repeat(64)}\n`,
    );
    expect(ledgerRevision(entries)).toBe(expected);
    // Absent is a line, not an omission.
    expect(ledgerRevision(entries.filter((e) => e.path !== "config.json"))).not.toBe(expected);
    // NFD and NFC name the same input.
    expect(ledgerRevision(entries.map((e) => ({ ...e, path: e.path.normalize("NFC") })))).toBe(expected);
  });

  it("changes on a one-byte, same-length edit to a ticket and to an issue", () => {
    const root = ledger();
    for (const rel of ["tickets/T-1.json", "issues/ISS-1.json"]) {
      const before = ledgerRevision(hashPass(root));
      const path = join(root, ".story", rel);
      const text = readFileSync(path, "utf-8");
      const edited = text.replace("Synthetic", "Synthetik");
      expect(edited.length).toBe(text.length);
      writeFileSync(path, edited);
      expect(ledgerRevision(hashPass(root))).not.toBe(before);
    }
  });

  it("an unreadable input makes the revision null and names the path", async () => {
    const root = ledger();
    mkdirSync(join(root, ".story", "tickets", "T-5.json"));
    const entries = hashPass(root);
    expect(entries.find((e) => e.path === "tickets/T-5.json")?.state.kind).toBe("unreadable");
    expect(ledgerRevision(entries)).toBeNull();
    const p = await projectionOf(root);
    expect(p.ledgerRevision).toBeNull();
    expect(p.diagnostics).toContainEqual({ file: "tickets/T-5.json", reason: "not a regular file" });
  });

  it("a change to the orchestrator pointer alone changes the revision", () => {
    const root = ledger({ pointer: true });
    const before = ledgerRevision(hashPass(root));
    const cfg = join(root, ".story", "config.json");
    writeFileSync(cfg, readFileSync(cfg, "utf-8").replace("../orchestrator", "../orchestratoR"));
    expect(ledgerRevision(hashPass(root))).not.toBe(before);
  });
});

describe("capture", () => {
  it("retries on a same-length concurrent edit and succeeds once the ledger holds still", async () => {
    const root = ledger();
    const path = join(root, ".story", "tickets", "T-1.json");
    let calls = 0;
    const out = await computeDecisionsProjection(root, CATALOGS, "structural", deps(root), {
      betweenPasses: () => {
        calls += 1;
        if (calls === 1) writeFileSync(path, readFileSync(path, "utf-8").replace("Synthetic", "Synthetik"));
      },
    });
    expect(calls).toBe(2);
    expect(out.revision).toBe(ledgerRevision(hashPass(root)));
  });

  it("fails after three attempts while the ledger keeps moving", async () => {
    const root = ledger();
    const path = join(root, ".story", "tickets", "T-1.json");
    let calls = 0;
    await expect(
      computeDecisionsProjection(root, CATALOGS, "structural", deps(root), {
        betweenPasses: () => {
          calls += 1;
          const t = readFileSync(path, "utf-8");
          writeFileSync(path, t.includes("Synthetic") ? t.replace("Synthetic", "Synthetik") : t.replace("Synthetik", "Synthetic"));
        },
      }),
    ).rejects.toThrow("ledger changing; projection not written");
    expect(calls).toBe(CAPTURE_ATTEMPTS);
  });
});

describe("resolutions", () => {
  it("every kind carries its field rules, and message equals citationWarningText on the same resolution", async () => {
    for (const opts of [{ pointer: true }, { unreadable: true }]) {
      const root = ledger(opts);
      const p = await projectionOf(root);
      const scan = loadRulingsSafe(root);
      const local = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries);
      const ctx = opts.pointer ? { ...local, upward: orchestrator() } : local;
      for (const c of p.citations) {
        const expected = resolveCitation(c.citedId, ctx);
        const text = citationWarningText(expected);
        const r = c.resolution;
        expect(r.message, c.citedId).toBe(text === "" ? "current" : text);
        expect(r.upwardDependency).toBe(opts.pointer === true);
        if (r.kind === "resolves-to") expect(r.target, c.citedId).toBeTruthy();
        if (r.kind === "competing" || r.kind === "cycle") expect(r.ids?.length, c.citedId).toBeGreaterThan(0);
        if (r.kind === "nonaccepted") expect(r.lifecycle && Array.isArray(r.reasons), c.citedId).toBe(true);
        if (r.kind === "indeterminate") expect(r.reason, c.citedId).toBeTruthy();
        if (r.kind === "indeterminate" && r.reason !== "unverifiable-successor") expect(r.ids).toBeUndefined();
        if (r.kind !== "resolves-to") expect(r.target).toBeUndefined();
      }
    }
  });

  it("the synthetic scenarios cover every resolution kind, including orchestrator-board results", async () => {
    const withBoard = await projectionOf(ledger({ pointer: true }));
    const unreadable = await projectionOf(ledger({ unreadable: true }));
    const kinds = new Set([...withBoard.citations, ...unreadable.citations].map((c) => c.resolution.kind));
    expect([...kinds].sort()).toEqual([...PROJECTION_RESOLUTION_KINDS].sort());
    expect(res(withBoard, SYN.orchCurrent)).toMatchObject({ kind: "current", board: "orchestrator" });
    expect(res(withBoard, SYN.orchOld)).toMatchObject({ kind: "resolves-to", board: "orchestrator", target: SYN.orchCurrent });
    expect(res(withBoard, SYN.current)).toMatchObject({ kind: "current", upwardDependency: true });
    expect(res(withBoard, SYN.current).board).toBeUndefined();
  });

  it("citations[] is exactly the union, and every resolves-to target is in rulings[] or on the orchestrator board", async () => {
    for (const opts of [{ pointer: true }, { unreadable: true }]) {
      const root = ledger(opts);
      const p = await projectionOf(root);
      const scan = loadRulingsSafe(root);
      const caps = JSON.parse(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")) as { capabilities: { rulings?: string[] }[] };
      const t1 = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-1.json"), "utf-8")) as { citesRulings: string[] };
      const iss = JSON.parse(readFileSync(join(root, ".story", "issues", "ISS-1.json"), "utf-8")) as { citesRulings: string[] };
      const union = new Set([...scan.rulings.map((r) => r.id), ...scan.unavailableIds, ...t1.citesRulings, ...iss.citesRulings, ...caps.capabilities.flatMap((c) => c.rulings ?? [])]);
      expect(p.citations.map((c) => c.citedId)).toEqual([...union].sort());
      expect(p.citations.map((c) => c.citedId)).toContain(SYN.missing);
      const ids = new Set(p.rulings.map((r) => r.id));
      for (const c of p.citations) {
        if (c.resolution.kind === "resolves-to") expect(ids.has(c.resolution.target!) || c.resolution.board === "orchestrator", c.citedId).toBe(true);
      }
    }
  });
});

describe("rulings[]", () => {
  it("lifecycle equals lifecycleMapFor for every record, and every lifecycle is present", async () => {
    const root = ledger({ pointer: true });
    const p = await projectionOf(root);
    const scan = loadRulingsSafe(root);
    const map = lifecycleMapFor(scan.rulings, buildSuccessorIndex(scan.rulings));
    for (const r of p.rulings) expect(r.lifecycle, r.id).toBe(map.get(r.id));
    expect(new Set(p.rulings.map((r) => r.lifecycle)).size).toBe(7);
  });

  it("proposalsAgainst and supersededBy agree with formatDecisionsListing's chain", async () => {
    const root = ledger({ pointer: true });
    const p = await projectionOf(root);
    const scan = loadRulingsSafe(root);
    const ctx = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness);
    const listing = formatDecisionsListing(scan.rulings, ctx.lifecycleById, ctx);
    const blocks = listing.split("\n### ").slice(1);
    expect(blocks).toHaveLength(p.rulings.length);
    for (const block of blocks) {
      const [, id, lc] = /^(r-[0-9a-z]+) \[([a-z-]+)\]/.exec(block)!;
      const row = p.rulings.find((r) => r.id === id)!;
      expect(row.lifecycle).toBe(lc);
      const sup = /superseded by ([^;\n]+)/.exec(block)?.[1]?.split(", ") ?? [];
      expect(row.supersededBy).toEqual([...sup].sort());
      const props = /Proposals against this ruling \(not binding\): ([^\n]+)/.exec(block)?.[1]?.split(", ") ?? [];
      expect(row.proposalsAgainst).toEqual([...props].sort());
    }
    expect(p.rulings.find((r) => r.id === SYN.current)!.proposalsAgainst).toEqual([SYN.proposed]);
    expect(p.rulings.find((r) => r.id === SYN.quarantined)!.proposalsAgainst).toEqual([]);
  });
});

describe("upward dependency", () => {
  it("an orchestrator successor added after the write changes nothing that was shown as verified", async () => {
    const root = ledger({ pointer: true });
    const before = await projectionOf(root);
    expect(res(before, SYN.current)).toMatchObject({ kind: "current", upwardDependency: true });
    const r = { id: "r-nnnnnnnnnnnnnnnn", text: "x", attribution: "owner-direct", recordedBy: { client: "c", id: "i" }, date: "2026-09-11", scopeTags: [], supersedes: SYN.current, createdAt: "2026-09-11T00:00:00.000Z" };
    const after = await projectionOf(root, "structural", { upwardBoard: () => orchestrator([r]) });
    expect(after.ledgerRevision).toBe(before.ledgerRevision);
    expect(res(after, SYN.current).kind).toBe("indeterminate");
    // The entry the successor moved was never a verified claim.
    for (const c of before.citations) {
      if (res(after, c.citedId).kind !== c.resolution.kind) expect(c.resolution.upwardDependency, c.citedId).toBe(true);
    }
  });

  describe("a linked project whose rulings nothing cites", () => {
    const uncited = (): string => {
      const root = ledger({ pointer: true });
      const story = join(root, ".story");
      for (const dir of ["tickets", "issues"]) rmSync(join(story, dir), { recursive: true, force: true });
      rmSync(join(story, "capabilities.json"));
      return root;
    };

    it("still reads the board: an unreadable orchestrator leaves no local ruling current", async () => {
      const board = vi.fn((): UpwardBoard => ({ kind: "unreadable", reason: "orchestrator missing" }));
      const p = await projectionOf(uncited(), "structural", { upwardBoard: board });
      expect(board).toHaveBeenCalled();
      expect(p.upwardBoard.pointer).toBe("recorded");
      expect(res(p, SYN.current).kind).not.toBe("current");
      expect(res(p, SYN.current).upwardDependency).toBe(true);
    });

    it("still reads the board: an orchestrator successor makes the local ruling indeterminate", async () => {
      const r = { id: "r-nnnnnnnnnnnnnnnn", text: "x", attribution: "owner-direct", recordedBy: { client: "c", id: "i" }, date: "2026-09-11", scopeTags: [], supersedes: SYN.current, createdAt: "2026-09-11T00:00:00.000Z" };
      const p = await projectionOf(uncited(), "structural", { upwardBoard: () => orchestrator([r]) });
      expect(res(p, SYN.current)).toMatchObject({ kind: "indeterminate", upwardDependency: true });
    });
  });

  it("with no pointer every upwardDependency is false and the board is not loaded", async () => {
    const root = ledger();
    const board = vi.fn(() => orchestrator());
    const p = await projectionOf(root, "structural", { upwardBoard: (ptr) => (ptr.ok || ptr.code !== "no-pointer" ? board() : undefined) });
    expect(board).not.toHaveBeenCalled();
    expect(p.upwardBoard).toEqual({ pointer: "none", state: "not-loaded" });
    for (const c of p.citations) expect(c.resolution.upwardDependency, c.citedId).toBe(false);
  });
});

describe("capability freshness", () => {
  const report = (results: { code: string }[], unchecked: string[] = []): CapabilityCheckReport =>
    ({ entries: [{ id: "cap", storedStatus: "current", effectiveStatus: "review", results, pendingNote: null }], head: null, unchecked, gitCalls: 0, deadlineHit: false }) as unknown as CapabilityCheckReport;

  it("maps one case per kind", () => {
    expect(freshnessKind(report([{ code: "capability_changed" }]), "cap", "full")).toBe("changed");
    expect(freshnessKind(report([{ code: "capability_unverifiable_checkpoint" }]), "cap", "full")).toBe("unverifiable");
    expect(freshnessKind(report([{ code: "capability_check_timeout" }]), "cap", "full")).toBe("check-incomplete");
    expect(freshnessKind(report([], ["cap"]), "cap", "full")).toBe("check-incomplete");
    expect(freshnessKind(report([]), "cap", "full")).toBe("current");
    expect(freshnessKind(report([{ code: "capability_changed" }]), "cap", "structural")).toBe("not-checked");
    // A reference-side incomplete result says nothing about freshness.
    expect(freshnessKind(report([{ code: "capability_check_incomplete" }]), "cap", "full")).toBe("current");
  });

  it("a full write then a structural write: every kind is not-checked, and effectiveStatus equals the --no-check result", async () => {
    const root = ledger();
    const fullDeps = { ...deps(root), check: async (entries: Parameters<ProjectionDeps["check"]>[0], state: Parameters<ProjectionDeps["check"]>[1], options: Parameters<ProjectionDeps["check"]>[2]) => {
      const r = await checkCapabilities(root, entries, state, { ...options, skipFreshness: true });
      return { ...r, entries: r.entries.map((e) => ({ ...e, effectiveStatus: "review" as const, results: [{ code: "capability_changed" as const, cls: "freshness" as const, detail: "x" }] })) };
    } };
    await writeDecisionsProjection(root, { mode: "full", deadlineMs: 30_000, deps: fullDeps });
    const full = JSON.parse(readFileSync(projectionPath(root), "utf-8")) as Projection;
    expect(full.capabilities.every((c) => c.freshness.kind === "changed")).toBe(true);
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000, deps: { now: deps(root).now, headCommit: async () => null } });
    const structural = JSON.parse(readFileSync(projectionPath(root), "utf-8")) as Projection;
    expect(structural.capabilities.map((c) => c.freshness.kind)).toEqual(structural.capabilities.map(() => "not-checked"));
    const { state } = await loadProject(root);
    const doc = capabilityCatalog.load(root).doc;
    const noCheck = await checkCapabilities(root, doc.capabilities, state, { skipFreshness: true });
    expect(structural.capabilities.map((c) => [c.id, c.effectiveStatus])).toEqual([...noCheck.entries].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => [e.id, e.effectiveStatus]));
  });
});

describe("deadline and lock", () => {
  it("a slow capture past the budget publishes nothing", async () => {
    const root = ledger();
    let t = 0;
    await expect(
      writeDecisionsProjection(root, { mode: "structural", deadlineMs: 1_000, now: () => t, deps: deps(root), betweenPasses: () => { t += 5_000; } }),
    ).rejects.toThrow(/deadline passed/);
    expect(existsSync(projectionPath(root))).toBe(false);
  });

  it("a slow check past the budget publishes nothing", async () => {
    const root = ledger();
    let t = 0;
    const slow: ProjectionDeps["check"] = async (e, s, o) => { t += 5_000; return structuralCheck(root)(e, s, o); };
    await expect(writeDecisionsProjection(root, { mode: "structural", deadlineMs: 1_000, now: () => t, deps: { ...deps(root), check: slow } })).rejects.toThrow(/deadline passed \(check\)/);
    expect(existsSync(projectionPath(root))).toBe(false);
  });

  describe("publication", () => {
    afterEach(() => { projectionTestHooks.afterTempWrite = undefined; });
    const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

    it("a deadline that passes during the temporary write keeps the previous projection", async () => {
      const root = ledger();
      await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000, deps: deps(root) });
      const previous = readFileSync(projectionPath(root), "utf-8");
      let t = 0;
      projectionTestHooks.afterTempWrite = () => { t += 5_000; };
      await expect(
        writeDecisionsProjection(root, { mode: "structural", deadlineMs: 1_000, now: () => t, deps: { ...deps(root), now: () => new Date("2027-01-01T00:00:00.000Z") } }),
      ).rejects.toThrow(/deadline passed \(publication\)/);
      expect(readFileSync(projectionPath(root), "utf-8")).toBe(previous);
      expect(leftovers(join(root, ".story", "cache"))).toEqual([]);
    });

    const outsideSwap = (root: string): { outside: string; swap: () => void } => {
      const outside = mkdtempSync(join(tmpdir(), "projection-outside-"));
      roots.push(outside);
      const cache = join(root, ".story", "cache");
      return { outside, swap: () => { renameSync(cache, `${cache}.orig`); symlinkSync(outside, cache); } };
    };

    it("a cache directory replaced by a symlink after the lock writes nothing outside the project", async () => {
      const root = ledger();
      const { outside, swap } = outsideSwap(root);
      await expect(writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000, deps: deps(root), afterLock: swap })).rejects.toThrow(/cache directory replaced/);
      expect(readdirSync(outside)).toEqual([]);
    });

    it("a cache directory replaced after the temporary write is not published through", async () => {
      const root = ledger();
      const { outside, swap } = outsideSwap(root);
      projectionTestHooks.afterTempWrite = swap;
      await expect(writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000, deps: deps(root) })).rejects.toThrow(/cache directory replaced \(publication\)/);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(root, ".story", "cache.orig", "decisions-projection.json"))).toBe(false);
    });
  });

  it("structural mode skips at once under lock contention; full mode waits at most about 5 s", async () => {
    const root = ledger();
    const cache = join(root, ".story", "cache");
    mkdirSync(cache, { recursive: true });
    const release = await lockfile.lock(cache, { lockfilePath: join(cache, ".projection.lock"), stale: 30_000 });
    try {
      let start = Date.now();
      await expect(writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000, deps: deps(root) })).rejects.toThrow("another writer holds the lock");
      expect(Date.now() - start).toBeLessThan(1_000);
      start = Date.now();
      await expect(writeDecisionsProjection(root, { mode: "full", deadlineMs: 30_000, deps: deps(root) })).rejects.toThrow("another writer holds the lock");
      const waited = Date.now() - start;
      expect(waited).toBeGreaterThanOrEqual(4_000);
      expect(waited).toBeLessThan(8_000);
    } finally {
      await release();
    }
    expect(existsSync(projectionPath(root))).toBe(false);
  });
});

describe("fixtures", () => {
  it("the checked-in projection fixtures equal the generator's output byte for byte", async () => {
    for (const [name, generate] of Object.entries(PROJECTION_FIXTURES)) {
      expect(await generate(), name).toBe(readFileSync(join(PROJECTION_FIXTURE_DIR, name), "utf-8"));
    }
  });

  it("the labels file has not drifted from the functions that render them", () => {
    expect(serializeRulingLabels()).toBe(readFileSync(LABELS_OUT, "utf-8"));
  });

  it("generating the continuity projection never touches test/fixtures/continuity", async () => {
    const dir = resolve(__dirname, "../fixtures/continuity");
    const before = hashTree(dir).sha256;
    await generateContinuityProjection();
    expect(hashTree(dir).sha256).toBe(before);
    expect(existsSync(join(dir, "core", ".story", "cache"))).toBe(false);
  });
});
