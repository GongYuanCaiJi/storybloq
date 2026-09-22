import { describe, it, expect } from "vitest";
import { RulingSchema, type Ruling } from "../../src/models/ruling.js";
import {
  buildSuccessorIndex,
  buildCitationResolutionContext,
  resolveCitation,
  validateSupersedeCandidate,
  validateAcceptCandidate,
  citationWarningText,
} from "../../src/core/ruling.js";
import { lifecycleOf, isEffectivelyAccepted, payloadDigest, proposalsFor, proposalsAgainst } from "../../src/core/ruling-lifecycle.js";
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D, FIXTURE_E, FIXTURE_F, DIGEST_B } from "../fixtures/ruling-lifecycle-fixtures.js";

/**
 * T-522 plan section 3: lifecycle-aware index and resolution.
 *
 * RED against 236b9fc1: `buildSuccessorIndex` indexes every record's
 * `supersedes` regardless of status, so a hand-written proposal carrying an
 * edge displaces R1 today; `resolveCitation` has no `nonaccepted` status;
 * `validateSupersedeCandidate` has no `target_not_accepted` code; there is
 * no `validateAcceptCandidate`.
 */
const parse = (f: unknown): Ruling => RulingSchema.parse(f);
const R1 = parse(FIXTURE_C);
const ctxOf = (rulings: Ruling[], unavailable: string[] = []) =>
  buildCitationResolutionContext(rulings, new Set(unavailable), "complete");

describe("buildSuccessorIndex with lifecycle", () => {
  it("does not index a proposal's proposesToSupersede: R1 stays current", () => {
    const P = parse(FIXTURE_A);
    const index = buildSuccessorIndex([R1, P]);
    expect(index.successorsByTarget.get(R1.id)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(R1.id)).toBeUndefined();
    const res = resolveCitation(R1.id, ctxOf([R1, P]));
    expect(res).toMatchObject({ status: "resolved", stale: false });
  });

  it("a hand-written proposal WITH supersedes is quarantined: not indexed, R1 current, unavailableIds empty", () => {
    const P = parse({ ...FIXTURE_A, supersedes: R1.id });
    const ctx = ctxOf([R1, P]);
    expect(ctx.lifecycleById.get(P.id)).toBe("quarantined");
    expect(ctx.unavailableIds.size).toBe(0);
    expect(resolveCitation(R1.id, ctx)).toMatchObject({ status: "resolved", stale: false });
  });

  it("indexes an accepted successor: R1 resolves forward to B", () => {
    const B = parse(FIXTURE_B);
    const res = resolveCitation(R1.id, ctxOf([R1, B]));
    expect(res).toMatchObject({ status: "resolved", stale: true, current: { id: B.id } });
    expect(lifecycleOf(R1, buildSuccessorIndex([R1, B]))).toBe("superseded");
  });

  it("a LEGACY record superseding a proposal is an uncertain edge, never authoritative (target not accepted)", () => {
    const P = parse(FIXTURE_A);
    const X = parse({ ...FIXTURE_C, id: "r-6666666666666666", supersedes: P.id });
    const index = buildSuccessorIndex([R1, P, X]);
    expect(index.successorsByTarget.get(P.id)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(P.id)).toEqual([X.id]);
  });

  it("a VALID accepted record superseding a proposal keeps lifecycle accepted but its edge is uncertain (target not accepted)", () => {
    const P = parse(FIXTURE_A);
    const draft = { ...FIXTURE_F, id: "r-6666666666666666", supersedes: P.id, proposesToSupersede: P.id };
    const X = parse({ ...draft, acceptance: { ...FIXTURE_F.acceptance, payloadDigest: payloadDigest(parse({ ...draft, acceptance: undefined })) } });
    const index = buildSuccessorIndex([R1, P, X]);
    expect(index.baseLifecycleById.get(X.id)).toBe("accepted");
    expect(index.successorsByTarget.get(P.id)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(P.id)).toEqual([X.id]);
  });

  it("a 1.15-style accepted successor of a PROPOSAL is an uncertain edge, never authoritative", () => {
    const P = parse(FIXTURE_A);
    const X = parse({ ...FIXTURE_F, id: "r-6666666666666666", supersedes: P.id, proposesToSupersede: P.id, acceptance: { ...FIXTURE_F.acceptance, payloadDigest: "0".repeat(64) } });
    // X's digest is wrong on purpose so it is quarantined; a 1.16 writer cannot
    // produce a successor of a proposal, so the only way here is by hand.
    const index = buildSuccessorIndex([R1, P, X]);
    expect(index.successorsByTarget.get(P.id)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(P.id)).toEqual([X.id]);
  });
});

describe("resolveCitation: nonaccepted and uncertain successors", () => {
  it.each([
    ["proposed", FIXTURE_A],
    ["withdrawn", FIXTURE_E],
  ])("a citation of a %s record is nonaccepted, and the warning says it binds nothing", (_n, f) => {
    const rec = parse(f);
    const res = resolveCitation(rec.id, ctxOf([R1, rec]));
    expect(res.status).toBe("nonaccepted");
    expect(citationWarningText(res)).toMatch(/binds nothing/);
  });

  it("accepted R2 superseding R1, then edited into a digest mismatch: R2 nonaccepted, R1 indeterminate naming R2", () => {
    const R2 = parse({ ...FIXTURE_B, text: "edited after acceptance" });
    const ctx = ctxOf([R1, R2]);
    expect(resolveCitation(R2.id, ctx)).toMatchObject({ status: "nonaccepted", lifecycle: "quarantined" });
    expect(resolveCitation(R1.id, ctx)).toMatchObject({ status: "indeterminate", reason: "unverifiable-successor", ids: [R2.id] });
  });

  it("uncertainty two hops down: R1 -> B verified, B has a quarantined successor Q; citing R1 is indeterminate naming Q", () => {
    const B = parse(FIXTURE_B);
    const Q = parse({ ...FIXTURE_B, id: "r-8888888888888888", supersedes: B.id, proposesToSupersede: B.id, text: "edited" });
    expect(resolveCitation(R1.id, ctxOf([R1, B, Q]))).toEqual({ status: "indeterminate", citedId: R1.id, reason: "unverifiable-successor", ids: [Q.id] });
  });

  it("two uncertain successors on one target are listed once each, in load order", () => {
    const Q1 = parse({ ...FIXTURE_B, id: "r-8888888888888888", text: "edited 1" });
    const Q2 = parse({ ...FIXTURE_B, id: "r-9999999999999999", text: "edited 2" });
    expect(resolveCitation(R1.id, ctxOf([R1, Q2, Q1]))).toMatchObject({ ids: [Q2.id, Q1.id] });
    expect(buildSuccessorIndex([R1, Q1]).uncertainSuccessorsByTarget.get(R1.id)).toEqual([Q1.id]);
  });

  it("removing the edge from a quarantined successor still leaves the original predecessor indeterminate", () => {
    const R2 = parse({ ...FIXTURE_B, supersedes: null });
    const ctx = ctxOf([R1, R2]);
    expect(ctx.lifecycleById.get(R2.id)).toBe("quarantined");
    expect(resolveCitation(R1.id, ctx)).toMatchObject({ status: "indeterminate", reason: "unverifiable-successor" });
  });

  it("redirecting the edge to R3 leaves BOTH R1 and R3 indeterminate", () => {
    const R3 = parse({ ...FIXTURE_D, id: "r-7777777777777777" });
    const R2 = parse({ ...FIXTURE_B, supersedes: R3.id });
    const ctx = ctxOf([R1, R2, R3]);
    expect(resolveCitation(R1.id, ctx)).toEqual({ status: "indeterminate", citedId: R1.id, reason: "unverifiable-successor", ids: [R2.id] });
    expect(resolveCitation(R3.id, ctx)).toEqual({ status: "indeterminate", citedId: R3.id, reason: "unverifiable-successor", ids: [R2.id] });
  });

  it("uncertainty is per chain, not global: an unrelated ruling still resolves", () => {
    const R2 = parse({ ...FIXTURE_B, text: "edited" });
    const D = parse(FIXTURE_D);
    expect(resolveCitation(D.id, ctxOf([R1, R2, D]))).toMatchObject({ status: "resolved", stale: false });
  });

  it("a conflicted record whose two acceptance-claiming sides name different targets makes both targets indeterminate", () => {
    const R3 = parse({ ...FIXTURE_D, id: "r-7777777777777777" });
    const theirs = { ...FIXTURE_B, supersedes: R3.id, proposesToSupersede: R3.id };
    const R2 = parse({
      ...FIXTURE_B,
      _conflicts: [{ fieldPath: "lifecycle", kind: "coupled", group: "lifecycle", base: null, ours: null, theirs }],
    });
    const ctx = ctxOf([R1, R2, R3]);
    expect(ctx.lifecycleById.get(R2.id)).toBe("conflicted");
    expect(resolveCitation(R2.id, ctx)).toMatchObject({ status: "nonaccepted", lifecycle: "conflicted" });
    expect(resolveCitation(R1.id, ctx)).toEqual({ status: "indeterminate", citedId: R1.id, reason: "unverifiable-successor", ids: [R2.id] });
    expect(resolveCitation(R3.id, ctx)).toEqual({ status: "indeterminate", citedId: R3.id, reason: "unverifiable-successor", ids: [R2.id] });
  });

  it("proposed-versus-accepted conflict introduces uncertainty; proposed-versus-malformed-proposed does not", () => {
    const acceptedSide = FIXTURE_B;
    const P1 = parse({ ...FIXTURE_A, _conflicts: [{ fieldPath: "lifecycle", kind: "coupled", group: "lifecycle", base: null, ours: null, theirs: acceptedSide }] });
    expect(resolveCitation(R1.id, ctxOf([R1, P1]))).toMatchObject({ status: "indeterminate", reason: "unverifiable-successor" });

    const malformedProposal = { ...FIXTURE_A, supersedes: R1.id };
    const P2 = parse({ ...FIXTURE_A, _conflicts: [{ fieldPath: "lifecycle", kind: "coupled", group: "lifecycle", base: null, ours: null, theirs: malformedProposal }] });
    expect(resolveCitation(R1.id, ctxOf([R1, P2]))).toMatchObject({ status: "resolved", stale: false });
  });

  it("an unreadable file anywhere still taints everything exactly as before", () => {
    expect(resolveCitation(R1.id, ctxOf([R1], ["r-0000000000000009"]))).toMatchObject({ status: "indeterminate", reason: "unreadable-successor" });
  });
});

describe("validateSupersedeCandidate with lifecycle", () => {
  it("refuses a proposed target", () => {
    const P = parse(FIXTURE_A);
    const r = validateSupersedeCandidate([R1, P], "r-8888888888888888", P.id);
    expect(r).toMatchObject({ code: "target_not_accepted" });
    expect(r?.detail).toMatch(/proposed/);
  });

  it("refuses a withdrawn target", () => {
    const W = parse(FIXTURE_E);
    expect(validateSupersedeCandidate([R1, W], "r-8888888888888888", W.id)).toMatchObject({ code: "target_not_accepted" });
  });

  it.each([
    ["quarantined", { ...FIXTURE_B, text: "edited" }],
    ["conflicted", { ...FIXTURE_B, _conflicts: [{ fieldPath: "lifecycle", kind: "coupled", group: "lifecycle", base: null, ours: null, theirs: FIXTURE_B }] }],
  ])("refuses a target whose successor is %s, with and without --branch, before the branch rule", (_n, succ) => {
    const R2 = parse(succ);
    for (const branch of [false, true]) {
      const r = validateSupersedeCandidate([R1, R2], "r-8888888888888888", R1.id, { branch });
      expect(r).toMatchObject({ code: "unverifiable_graph" });
    }
  });

  it("refuses a would-be successor that is itself a proposal or withdrawn, and points a proposal at accept", () => {
    const P = parse(FIXTURE_A);
    const W = parse(FIXTURE_E);
    const r = validateSupersedeCandidate([R1, P], P.id, R1.id);
    expect(r).toMatchObject({ code: "successor_not_acceptable" });
    expect(r?.detail).toMatch(/ruling accept/);
    expect(validateSupersedeCandidate([R1, W], W.id, R1.id)).toMatchObject({ code: "successor_not_acceptable" });
  });

  it("an uncertain claim on the SECOND branch of a target is found, with and without --branch (Codex round 1 finding)", () => {
    // R1 <- B (verified) and R1 <- C (verified): a branch. C has a quarantined
    // successor Q. Walking only B's path would miss Q; --branch must not turn
    // that miss into an accepted write.
    const B = parse(FIXTURE_B);
    const C = parse({ ...FIXTURE_F, id: "r-7777777777777777" });
    const Q = parse({ ...FIXTURE_B, id: "r-8888888888888888", supersedes: C.id, proposesToSupersede: C.id, text: "edited" });
    for (const branch of [false, true]) {
      const r = validateSupersedeCandidate([R1, B, C, Q], "r-9999999999999999", R1.id, { branch });
      expect(r).toMatchObject({ code: "unverifiable_graph" });
      expect(r?.detail).toContain(Q.id);
    }
    const P = parse({ ...FIXTURE_A, id: "r-9999999999999999" });
    expect(validateAcceptCandidate(P, DIGEST_B, ctxOf([R1, B, C, Q, P]), () => true, { branch: true })).toMatchObject({ code: "unverifiable_graph" });
  });

  it("still detects a branch over verified successors and lets --branch through", () => {
    const B = parse(FIXTURE_B);
    expect(validateSupersedeCandidate([R1, B], "r-8888888888888888", R1.id)).toMatchObject({ code: "branch" });
    expect(validateSupersedeCandidate([R1, B], "r-8888888888888888", R1.id, { branch: true })).toBeNull();
  });
});

describe("validateAcceptCandidate", () => {
  const items = new Set(["T-2"]);
  const ok = (rulings: Ruling[], p: Ruling, revision = DIGEST_B, opts: { branch?: boolean } = {}) =>
    validateAcceptCandidate(p, revision, ctxOf(rulings), (id) => items.has(id), opts);

  it("accepts fixture A against R1 with the right revision", () => {
    const P = parse(FIXTURE_A);
    expect(ok([R1, P], P)).toBeNull();
  });

  it("refuses when the text was edited after review (revision mismatch)", () => {
    const P = parse({ ...FIXTURE_A, text: "edited" });
    expect(ok([R1, P], P)).toMatchObject({ code: "revision_mismatch" });
  });

  it("refuses a record that is not proposed", () => {
    const D = parse(FIXTURE_D);
    expect(ok([R1, D], D)).toMatchObject({ code: "successor_not_acceptable" });
  });

  it("refuses when the target was withdrawn or is itself a proposal", () => {
    const P = parse(FIXTURE_A);
    const targetProposal = parse({ ...FIXTURE_D, id: R1.id, status: "proposed", acceptance: undefined, proposesToSupersede: null });
    expect(ok([targetProposal, P], P)).toMatchObject({ code: "target_not_accepted" });
  });

  it("refuses when the target was superseded since drafting unless --branch", () => {
    const P = parse(FIXTURE_A);
    const F = parse(FIXTURE_F);
    expect(ok([R1, F, P], P)).toMatchObject({ code: "branch" });
    expect(ok([R1, F, P], P, DIGEST_B, { branch: true })).toBeNull();
  });

  it("refuses when a proposedFor id resolves to nothing", () => {
    const P = parse({ ...FIXTURE_A, proposedFor: ["T-404"] });
    // proposedFor is inside the digest, so the revision must be recomputed.
    const r = validateAcceptCandidate(P, payloadDigest(P), ctxOf([R1, P]), () => false, {});
    expect(r).toMatchObject({ code: "dangling_item" });
  });

  it("refusal precedence under combined failures (Codex T2 minor)", () => {
    // stale revision + unreadable graph -> revision_mismatch
    const P = parse(FIXTURE_A);
    expect(validateAcceptCandidate(P, "0".repeat(64), ctxOf([R1, P], ["r-0000000000000009"]), () => false, {})).toMatchObject({ code: "revision_mismatch" });
    // valid revision + unreadable graph + missing item -> unverifiable_graph
    expect(validateAcceptCandidate(P, DIGEST_B, ctxOf([R1, P], ["r-0000000000000009"]), () => false, {})).toMatchObject({ code: "unverifiable_graph" });
    // valid revision + nonaccepted target + missing item -> target_not_accepted
    const targetProposal = parse({ ...FIXTURE_D, id: R1.id, status: "proposed", acceptance: undefined, proposesToSupersede: null });
    expect(validateAcceptCandidate(P, DIGEST_B, ctxOf([targetProposal, P]), () => false, {})).toMatchObject({ code: "target_not_accepted" });
  });

  it("refuses when any ruling file is unreadable", () => {
    const P = parse(FIXTURE_A);
    const r = validateAcceptCandidate(P, DIGEST_B, ctxOf([R1, P], ["r-0000000000000009"]), (id) => items.has(id), {});
    expect(r).toMatchObject({ code: "unverifiable_graph" });
  });
});

describe("proposal queries", () => {
  it("proposalsFor and proposalsAgainst list proposed records only", () => {
    const P = parse(FIXTURE_A);
    const W = parse(FIXTURE_E);
    const all = [R1, P, W, parse(FIXTURE_D)];
    expect(proposalsFor(all, "T-2").map((r) => r.id)).toEqual([P.id]);
    expect(proposalsAgainst(all, R1.id).map((r) => r.id)).toEqual([P.id]);
  });

  it("isEffectivelyAccepted covers accepted, accepted-legacy and superseded only", () => {
    expect(isEffectivelyAccepted("accepted")).toBe(true);
    expect(isEffectivelyAccepted("accepted-legacy")).toBe(true);
    expect(isEffectivelyAccepted("superseded")).toBe(true);
    for (const l of ["proposed", "withdrawn", "quarantined", "conflicted"] as const) expect(isEffectivelyAccepted(l)).toBe(false);
  });
});
