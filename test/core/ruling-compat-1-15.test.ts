import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as oracle from "./oracle-1-15/ruling-655b03bf.js";
import { RulingSchema as OracleRulingSchema } from "./oracle-1-15/ruling-schema-655b03bf.js";
import { RulingSchema } from "../../src/models/ruling.js";
import { buildSuccessorIndex, buildCitationResolutionContext, resolveCitation, validateSupersedeCandidate } from "../../src/core/ruling.js";
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D, FIXTURE_E, FIXTURE_F } from "../fixtures/ruling-lifecycle-fixtures.js";

/**
 * T-522 plan section 10: what a 1.15 reader does with a 1.16 ledger, proven
 * against VERBATIM copies of the 1.15 code pinned at 655b03bf (the plan
 * base). The oracle is the point: it does not change when `src/` changes, so
 * a 1.16 edit that would break a 1.15 client mid-upgrade fails HERE rather
 * than on the older client's machine.
 *
 * The compatibility contract these tests pin:
 *   1. every 1.16 record still PARSES under the 1.15 schema (passthrough);
 *   2. a proposal (no `supersedes`) is INVISIBLE to the 1.15 index, so the
 *      ruling it proposes to replace stays current on both readers;
 *   3. an accepted 1.16 successor resolves to the SAME chain on both readers;
 *   4. a legacy record is treated identically by both readers.
 * Where 1.15 and 1.16 legitimately DIFFER (a hand-written proposal carrying
 * `supersedes`), the divergence is recorded, not hidden.
 */
const ORACLE_SHA256 = {
  "ruling-655b03bf.ts": "d06f052e4b584af5ed369152d18eaca4e9beee718c46187a0c3a43b38abf8549",
  "ruling-schema-655b03bf.ts": "55d81bbff5140fe3380b69a5e656157538ac6ec419cc41cac99e1b9696f3be4c",
} as const;

/**
 * PROVENANCE (Codex T3 minor): the local sha256 above only guards against an
 * accidental edit of the checked-in copy. This pins the copy to the UPSTREAM
 * blob: reversing the documented transformation (drop the header lines, undo
 * the import-path rewrites) must reproduce the exact git blob at 655b03bf,
 * whose ids are `git rev-parse 655b03bf:storybloq/src/{core,models}/ruling.ts`.
 * Computed as git does (sha1 over "blob <len>\0<content>"), so no git history
 * is needed at test time.
 *
 * Deliberately NOT frozen: the primitives the oracle imports from
 * `src/models/types.ts` (RulingIdSchema, OwnerTaskLikeSchema, DateSchema,
 * TimestampSchema, RULING_CANONICAL_ID_REGEX). A change to any of those is a
 * ledger-format change in its own right, outside T-522, and would have to be
 * reviewed as one; this file simulates the 1.15 ruling READER, not 1.15's
 * every primitive.
 */
const ORACLE_UPSTREAM = {
  "ruling-655b03bf.ts": {
    blob: "d26dbb35b5998f4e23e645c484dce1ded8595406",
    headerLines: 4,
    rewrites: [
      ['"../../../src/models/', '"../models/'],
      ['"../../../src/core/ruling-loader.js"', '"./ruling-loader.js"'],
    ],
  },
  "ruling-schema-655b03bf.ts": {
    blob: "a22b5af691e1ca4eec40cdcee2b12bcfb5be4379",
    headerLines: 2,
    rewrites: [['"../../../src/models/types.js"', '"./types.js"']],
  },
} as const;

function gitBlobId(content: string): string {
  const body = Buffer.from(content, "utf-8");
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

const parseNew = (f: unknown) => RulingSchema.parse(f);
const parseOld = (f: unknown) => OracleRulingSchema.parse(f);
const ALL = [FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D, FIXTURE_E, FIXTURE_F];

describe("pinned 1.15 oracle", () => {
  it.each(Object.entries(ORACLE_SHA256))("%s is byte-identical to its pinned copy", (name, expected) => {
    const path = fileURLToPath(new URL(`./oracle-1-15/${name}`, import.meta.url));
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(expected);
  });

  it.each(Object.entries(ORACLE_UPSTREAM))("%s reverses to the exact upstream blob at 655b03bf", (name, spec) => {
    const path = fileURLToPath(new URL(`./oracle-1-15/${name}`, import.meta.url));
    let text = readFileSync(path, "utf-8").split("\n").slice(spec.headerLines).join("\n");
    for (const [local, upstream] of spec.rewrites) text = text.split(local).join(upstream);
    expect(gitBlobId(text)).toBe(spec.blob);
  });
});

describe("1.15 reader on a 1.16 ledger", () => {
  it("parses every 1.16 fixture under the 1.15 schema and keeps the unknown fields", () => {
    for (const f of ALL) {
      const parsed = parseOld(f);
      expect(parsed).toMatchObject(f);
    }
  });

  it("a proposal is invisible to the 1.15 successor index: R1 stays current on both readers", () => {
    const oldRulings = [parseOld(FIXTURE_C), parseOld(FIXTURE_A)];
    const oldIndex = oracle.buildSuccessorIndex(oldRulings);
    expect(oldIndex.successorsByTarget.get(FIXTURE_C.id)).toBeUndefined();
    const oldRes = oracle.resolveCitation(FIXTURE_C.id, oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete"));
    expect(oldRes).toMatchObject({ status: "resolved", stale: false });

    const newRulings = [parseNew(FIXTURE_C), parseNew(FIXTURE_A)];
    const newRes = resolveCitation(FIXTURE_C.id, buildCitationResolutionContext(newRulings, new Set(), "complete"));
    expect(newRes).toMatchObject({ status: "resolved", stale: false });
  });

  it("a withdrawn record is invisible to the 1.15 index exactly like a proposal", () => {
    const oldRulings = [parseOld(FIXTURE_C), parseOld(FIXTURE_E)];
    expect(oracle.buildSuccessorIndex(oldRulings).successorsByTarget.size).toBe(0);
  });

  it("an accepted successor resolves to the same chain on both readers", () => {
    const oldRulings = [parseOld(FIXTURE_C), parseOld(FIXTURE_B)];
    const oldRes = oracle.resolveCitation(FIXTURE_C.id, oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete"));
    const newRulings = [parseNew(FIXTURE_C), parseNew(FIXTURE_B)];
    const newRes = resolveCitation(FIXTURE_C.id, buildCitationResolutionContext(newRulings, new Set(), "complete"));
    expect(oldRes.status).toBe("resolved");
    expect(newRes.status).toBe("resolved");
    if (oldRes.status === "resolved" && newRes.status === "resolved") {
      expect(newRes.chain).toEqual(oldRes.chain);
      expect(newRes.current.id).toBe(oldRes.current.id);
      expect(newRes.stale).toBe(oldRes.stale);
    }
  });

  it("a 1.15 reader citing a PROPOSAL sees it resolve as current: the 1.16 reader refuses (recorded divergence, not a bug)", () => {
    const oldRulings = [parseOld(FIXTURE_C), parseOld(FIXTURE_A)];
    const oldRes = oracle.resolveCitation(FIXTURE_A.id, oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete"));
    expect(oldRes).toMatchObject({ status: "resolved", stale: false });
    const newRulings = [parseNew(FIXTURE_C), parseNew(FIXTURE_A)];
    const newRes = resolveCitation(FIXTURE_A.id, buildCitationResolutionContext(newRulings, new Set(), "complete"));
    expect(newRes).toMatchObject({ status: "nonaccepted", lifecycle: "proposed" });
  });

  it("an accepted successor edited after acceptance: 1.15 still follows it, 1.16 quarantines it and holds R1 indeterminate (recorded divergence)", () => {
    const edited = { ...FIXTURE_B, text: FIXTURE_B.text + " (edited after acceptance)" };
    const oldRulings = [parseOld(FIXTURE_C), parseOld(edited)];
    const oldRes = oracle.resolveCitation(FIXTURE_C.id, oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete"));
    expect(oldRes).toMatchObject({ status: "resolved", stale: true, current: { id: FIXTURE_B.id } });
    const newCtx = buildCitationResolutionContext([parseNew(FIXTURE_C), parseNew(edited)], new Set(), "complete");
    expect(resolveCitation(FIXTURE_B.id, newCtx)).toMatchObject({ status: "nonaccepted", lifecycle: "quarantined" });
    expect(resolveCitation(FIXTURE_C.id, newCtx)).toEqual({ status: "indeterminate", citedId: FIXTURE_C.id, reason: "unverifiable-successor", ids: [FIXTURE_B.id] });
  });

  it("the 1.15 hazard: a hand-written proposal WITH supersedes displaces R1 on 1.15 and is quarantined on 1.16", () => {
    const hazard = { ...FIXTURE_A, supersedes: FIXTURE_C.id };
    const oldRulings = [parseOld(FIXTURE_C), parseOld(hazard)];
    const oldRes = oracle.resolveCitation(FIXTURE_C.id, oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete"));
    expect(oldRes).toMatchObject({ status: "resolved", stale: true, current: { id: FIXTURE_A.id } });
    const newRulings = [parseNew(FIXTURE_C), parseNew(hazard)];
    const newCtx = buildCitationResolutionContext(newRulings, new Set(), "complete");
    expect(newCtx.lifecycleById.get(FIXTURE_A.id)).toBe("quarantined");
    expect(resolveCitation(FIXTURE_C.id, newCtx)).toMatchObject({ status: "resolved", stale: false });
  });

  it("the 1.16 validateSupersedeCandidate agrees with 1.15 on every legacy-only graph", () => {
    const legacy = [parseNew(FIXTURE_C), parseNew({ ...FIXTURE_C, id: "r-1212121212121212", supersedes: FIXTURE_C.id })];
    for (const [n, o] of [
      ["r-1313131313131313", FIXTURE_C.id],
      ["r-1313131313131313", "r-1212121212121212"],
      [FIXTURE_C.id, "r-1212121212121212"],
      ["r-1313131313131313", "r-9999999999999999"],
      [FIXTURE_C.id, FIXTURE_C.id],
    ] as const) {
      expect(validateSupersedeCandidate(legacy, n, o)?.code ?? null).toBe(oracle.validateSupersedeCandidate(legacy, n, o)?.code ?? null);
    }
  });

  it("buildSuccessorIndex on a legacy-only ledger is identical on both readers", () => {
    const legacy = [parseNew(FIXTURE_C), parseNew({ ...FIXTURE_C, id: "r-1212121212121212", supersedes: FIXTURE_C.id })];
    const oldIndex = oracle.buildSuccessorIndex(legacy);
    const newIndex = buildSuccessorIndex(legacy);
    expect([...newIndex.successorsByTarget.entries()]).toEqual([...oldIndex.successorsByTarget.entries()]);
    expect([...newIndex.branchedTargets]).toEqual([...oldIndex.branchedTargets]);
    expect(newIndex.uncertainSuccessorsByTarget.size).toBe(0);
  });
});
