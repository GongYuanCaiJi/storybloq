#!/usr/bin/env tsx
/**
 * Writes the decisions-projection fixtures (T-528) the Mac app decodes:
 *
 * - `test/fixtures/projection/continuity.json`: the continuity core plus the
 *   arm-3 overlay, materialised into a temp directory (never written in place),
 *   projected in structural mode with the clock, version and head stubbed.
 * - `test/fixtures/projection/synthetic.json`: a synthetic ledger built in a
 *   temp directory, as three scenarios, because one ledger cannot hold them
 *   all: any unreadable ruling makes every otherwise-current citation
 *   indeterminate, so `unreadable` lives apart from `current`.
 *     - `full`: every lifecycle, every resolution kind but `unreadable`,
 *       orchestrator-board results through a stub upward board, the four
 *       checked freshness kinds through a stub check, a malformed ticket.
 *     - `structural`: the same ledger in structural mode (`not-checked`).
 *     - `unreadable`: no pointer, an unreadable ruling file and a filename/id
 *       mismatch. A true duplicate id cannot be constructed: the loader
 *       requires the filename to equal the id, so the mismatch is the case.
 *
 * Usage:
 *   tsx scripts/projection-fixtures.ts   # write both files
 * A test regenerates both in memory and compares byte for byte.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./continuity-lib.js";
import { checkCapabilities, effectiveStatus, type CapabilityCheckReport, type CapabilityCheckResult } from "../src/core/capability.js";
import { glossaryCatalog } from "../src/core/glossary.js";
import { buildCitationResolutionContext, type UpwardBoard } from "../src/core/ruling.js";
import { computeDecisionsProjection, type ProjectionDeps, type ProjectionMode } from "../src/core/decisions-projection.js";
import { capabilityCatalog } from "../src/cli/commands/capability.js";
import type { Ruling } from "../src/models/ruling.js";
import { FIXTURE_B, FIXTURE_C, FIXTURE_D, FIXTURE_E, FIXTURE_F } from "../test/fixtures/ruling-lifecycle-fixtures.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECTION_FIXTURE_DIR = join(pkgRoot, "test", "fixtures", "projection");
const CONTINUITY = join(pkgRoot, "test", "fixtures", "continuity");

export const FIXED_NOW = "2026-09-24T00:00:00.000Z";
export const FIXED_CLI_VERSION = "0.0.0-fixture";
export const FIXED_HEAD = "0123456789abcdef0123456789abcdef01234567";

const recordedBy = { client: "claude", id: "fixture-recorder" };
const legacy = (id: string, text: string, supersedes: string | null = null): Record<string, unknown> => ({
  id,
  text,
  attribution: "owner-direct",
  recordedBy,
  date: "2026-09-10",
  scopeTags: ["synthetic"],
  supersedes,
  createdAt: "2026-09-10T10:00:00.000Z",
});

/** Synthetic ids, one per role; every one is a valid ruling id. */
export const SYN = {
  competingTarget: FIXTURE_C.id, // superseded by B and F at once
  acceptedB: FIXTURE_B.id,
  current: FIXTURE_D.id,
  withdrawn: FIXTURE_E.id,
  acceptedF: FIXTURE_F.id,
  proposed: "r-6666666666666666",
  proposedAgainstQuarantined: "r-pppppppppppppppp",
  quarantined: "r-7777777777777777",
  conflicted: "r-8888888888888888",
  uncertainTarget: "r-9999999999999999",
  staleOld: "r-aaaaaaaaaaaaaaaa",
  staleNew: "r-bbbbbbbbbbbbbbbb",
  cycleA: "r-cccccccccccccccc",
  cycleB: "r-dddddddddddddddd",
  orchCurrent: "r-eeeeeeeeeeeeeeee",
  orchOld: "r-hhhhhhhhhhhhhhhh",
  missing: "r-zzzzzzzzzzzzzzzz",
  unreadableFile: "r-jjjjjjjjjjjjjjjj",
  mismatchFile: "r-kkkkkkkkkkkkkkkk",
  mismatchId: "r-mmmmmmmmmmmmmmmm",
} as const;

function syntheticRulings(): Record<string, unknown>[] {
  return [
    { ...FIXTURE_C },
    { ...FIXTURE_B },
    { ...FIXTURE_D },
    { ...FIXTURE_E },
    { ...FIXTURE_F },
    { ...legacy(SYN.proposed, "A proposal against the current ruling"), status: "proposed", proposesToSupersede: SYN.current, proposedFor: ["T-1"] },
    // A proposal against a record that is not effectively accepted: never listed as a proposal against it.
    { ...legacy(SYN.proposedAgainstQuarantined, "A proposal against a quarantined record"), status: "proposed", proposesToSupersede: SYN.quarantined, proposedFor: [] },
    // Claims acceptance with no acceptance record: quarantined, and an uncertain edge onto its target.
    { ...legacy(SYN.quarantined, "Claims acceptance without evidence", SYN.uncertainTarget), status: "accepted" },
    { ...legacy(SYN.conflicted, "A record with an unresolved merge conflict"), _conflicts: [{ field: "text", ours: "one wording", theirs: "another wording" }] },
    legacy(SYN.uncertainTarget, "The target of an unverifiable successor"),
    legacy(SYN.staleOld, "An older wording"),
    legacy(SYN.staleNew, "The newer wording", SYN.staleOld),
    legacy(SYN.cycleA, "One side of a cycle", SYN.cycleB),
    legacy(SYN.cycleB, "The other side of a cycle", SYN.cycleA),
  ];
}

function orchestratorBoard(): UpwardBoard {
  const rulings = [legacy(SYN.orchOld, "An orchestrator ruling since replaced"), legacy(SYN.orchCurrent, "The orchestrator's current ruling", SYN.orchOld)] as unknown as Ruling[];
  return { kind: "board", root: "/orchestrator", ctx: buildCitationResolutionContext(rulings, new Set(), "complete") };
}

const CITED = [
  SYN.current, SYN.competingTarget, SYN.staleOld, SYN.cycleA, SYN.proposed, SYN.withdrawn, SYN.quarantined,
  SYN.conflicted, SYN.uncertainTarget, SYN.missing, SYN.orchCurrent, SYN.orchOld,
];

const ticket = (id: string, citesRulings: readonly string[]): Record<string, unknown> => ({
  id,
  title: `Synthetic ${id}`,
  description: "Synthetic ticket for the projection fixture.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-09-10",
  completedDate: null,
  blockedBy: [],
  parentTicket: null,
  citesRulings: [...citesRulings],
});

const issue = (id: string, citesRulings: readonly string[]): Record<string, unknown> => ({
  id,
  title: `Synthetic ${id}`,
  status: "open",
  severity: "low",
  components: [],
  impact: "Synthetic issue for the projection fixture.",
  resolution: null,
  location: [],
  discoveredDate: "2026-09-10",
  resolvedDate: null,
  relatedTickets: [],
  citesRulings: [...citesRulings],
});

const capability = (id: string, file: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  summary: `Synthetic capability ${id}.`,
  surfaces: { files: [file] },
  entryPoints: [file],
  contract: `Synthetic contract for ${id}.`,
  checkedAt: { sha: "0000000000000000000000000000000000000000", date: "2026-09-15" },
  status: "current",
  ...extra,
});

/** The freshness each checked capability reports under the stub check. */
const STUB_FRESHNESS: Record<string, "changed" | "unverifiable" | "check-incomplete"> = {
  "cap-changed": "changed",
  "cap-unverifiable": "unverifiable",
  "cap-incomplete": "check-incomplete",
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function buildSyntheticLedger(root: string, opts: { readonly pointer: boolean; readonly unreadable: boolean }): void {
  const story = join(root, ".story");
  writeJson(join(story, "config.json"), {
    version: 2,
    project: "projection-synthetic",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...(opts.pointer && { orchestrator: "../orchestrator" }),
  });
  writeJson(join(story, "roadmap.json"), {
    title: "projection-synthetic",
    date: "2026-09-10",
    phases: [{ id: "p1", label: "PHASE 1", name: "Synthetic", description: "The synthetic projection ledger." }],
    blockers: [],
  });
  for (const r of syntheticRulings()) writeJson(join(story, "rulings", `${r.id as string}.json`), r);
  writeJson(join(story, "tickets", "T-1.json"), ticket("T-1", CITED));
  writeFileSync(join(story, "tickets", "T-9.json"), "{ not json\n");
  writeJson(join(story, "issues", "ISS-1.json"), issue("ISS-1", [SYN.current]));
  for (const f of ["changed", "current", "incomplete", "unverifiable"]) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", `${f}.ts`), `export const ${f} = 1;\n`);
  }
  writeJson(join(story, "capabilities.json"), {
    version: 1,
    capabilities: [
      capability("cap-changed", "src/changed.ts"),
      capability("cap-current", "src/current.ts", { rulings: [SYN.current], terms: ["term-alpha"] }),
      capability("cap-incomplete", "src/incomplete.ts"),
      capability("cap-unverifiable", "src/unverifiable.ts"),
    ],
  });
  writeJson(join(story, "glossary.json"), {
    version: 1,
    terms: [
      { id: "term-alpha", term: "alpha", definition: "A synthetic term.", capabilities: ["cap-current"], rulings: [SYN.current], updatedAt: "2026-09-15T00:00:00.000Z" },
    ],
  });
  if (opts.unreadable) {
    writeFileSync(join(story, "rulings", `${SYN.unreadableFile}.json`), "{ not json\n");
    writeJson(join(story, "rulings", `${SYN.mismatchFile}.json`), legacy(SYN.mismatchId, "Filed under another id"));
  }
}

/** The real structural check, with the freshness half stubbed per `STUB_FRESHNESS`. */
function stubCheck(root: string): ProjectionDeps["check"] {
  return async (entries, state, options) => {
    const real = await checkCapabilities(root, entries, state, { ...options, skipFreshness: true });
    if (options.skipFreshness) return real;
    const unchecked: string[] = [];
    const reported = real.entries.map((e) => {
      const kind = STUB_FRESHNESS[e.id];
      const extra: CapabilityCheckResult[] = [];
      if (kind === "changed") extra.push({ code: "capability_changed", cls: "freshness", detail: "1 file(s) under this entry's paths changed since 0000000" });
      if (kind === "unverifiable") extra.push({ code: "capability_unverifiable_checkpoint", cls: "freshness", detail: "the checkpoint commit is not in this repository" });
      if (kind === "check-incomplete") {
        extra.push({ code: "capability_check_timeout", cls: "incomplete", detail: "the check deadline passed before this entry was checked" });
        unchecked.push(e.id);
      }
      const results = [...e.results, ...extra];
      return { ...e, results, effectiveStatus: effectiveStatus(e.storedStatus, results, e.pendingNote !== null) };
    });
    const report: CapabilityCheckReport = { ...real, entries: reported, head: FIXED_HEAD, unchecked, deadlineHit: unchecked.length > 0 };
    return report;
  };
}

function fixedDeps(root: string, check: ProjectionDeps["check"], upwardBoard: ProjectionDeps["upwardBoard"]): ProjectionDeps {
  return { now: () => new Date(FIXED_NOW), cliVersion: FIXED_CLI_VERSION, headCommit: async () => FIXED_HEAD, check, upwardBoard };
}

const CATALOGS = { capabilities: capabilityCatalog, glossary: glossaryCatalog };

async function project(root: string, mode: ProjectionMode, deps: ProjectionDeps): Promise<Record<string, unknown>> {
  const { projection } = await computeDecisionsProjection(root, CATALOGS, mode, deps);
  const text = JSON.stringify(projection);
  for (const p of new Set([root, realpathSync(root)])) {
    if (text.includes(p)) throw new Error(`projection fixture names its temp directory ${p}`);
  }
  return projection;
}

function withTempRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const serialize = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

export async function generateContinuityProjection(): Promise<string> {
  return withTempRoot("projection-continuity-", async (root) => {
    materialize(CONTINUITY, 3, "T-2.a", root);
    const deps = fixedDeps(root, (entries, state, options) => checkCapabilities(root, entries, state, options), () => undefined);
    return serialize(await project(root, "structural", deps));
  });
}

export async function generateSyntheticProjection(): Promise<string> {
  const board = orchestratorBoard();
  const scenario = (pointer: boolean, unreadable: boolean, mode: ProjectionMode) =>
    withTempRoot("projection-synthetic-", async (root) => {
      buildSyntheticLedger(root, { pointer, unreadable });
      return project(root, mode, fixedDeps(root, stubCheck(root), (p) => (p.ok || p.code !== "no-pointer" ? board : undefined)));
    });
  return serialize({
    scenarios: {
      full: await scenario(true, false, "full"),
      structural: await scenario(true, false, "structural"),
      unreadable: await scenario(false, true, "structural"),
    },
  });
}

export const PROJECTION_FIXTURES = {
  "continuity.json": generateContinuityProjection,
  "synthetic.json": generateSyntheticProjection,
} as const;

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  mkdirSync(PROJECTION_FIXTURE_DIR, { recursive: true });
  for (const [name, generate] of Object.entries(PROJECTION_FIXTURES)) {
    const out = join(PROJECTION_FIXTURE_DIR, name);
    writeFileSync(out, await generate());
    process.stderr.write(`wrote ${out}\n`);
  }
}
