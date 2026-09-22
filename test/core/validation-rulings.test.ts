import { describe, it, expect } from "vitest";
import { validateProject } from "../../src/core/validation.js";
import { makeTicket, makeIssue, makeRuling, makeState } from "./test-factories.js";

describe("validateProject with rulings aux", () => {
  it("runs no ruling checks at all when aux.rulings is not supplied (pre-T-476 behavior unchanged)", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-does-not-exist000"] })] });
    const result = validateProject(state);
    expect(result.findings.filter((f) => f.code.includes("ruling"))).toEqual([]);
  });

  it("flags a citation to a ruling that has been superseded", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "superseded_ruling_citation");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("T-1");
    expect(finding?.message).toContain("r-0000000000000002");
  });

  it("does not flag a citation to a current (non-superseded) ruling", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    // T-494: `citingEntityLoadComplete` is stated explicitly rather than left
    // absent, because absent now means UNKNOWN and this fixture's whole point
    // is a complete, uncorrupted load.
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "complete",
      citingEntityLoadComplete: true,
    });
    expect(result.findings.filter((f) => f.code.includes("ruling"))).toEqual([]);
  });

  it("flags a dangling citation to a ruling id that does not exist", () => {
    const state = makeState({ issues: [makeIssue({ id: "ISS-1", citesRulings: ["r-doesnotexist0001"] })] });
    const result = validateProject(state, undefined, { rulings: [], unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "dangling_ruling_citation");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("ISS-1");
  });

  it("flags a citation to a currently-unreadable ruling", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-broken000000001"] })] });
    const result = validateProject(state, undefined, {
      rulings: [],
      unavailableRulingIds: new Set(["r-broken000000001"]),
      rulingScanCompleteness: "complete",
    });
    const finding = result.findings.find((f) => f.code === "unreadable_ruling_citation");
    expect(finding).toBeDefined();
  });

  it("ruling #4: flags every citation as indeterminate when the ruling scan is incomplete, never dangling", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, {
      rulings: [],
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "incomplete",
    });
    const finding = result.findings.find((f) => f.code === "ruling_indeterminate_citation");
    expect(finding).toBeDefined();
    expect(result.findings.some((f) => f.code === "dangling_ruling_citation")).toBe(false);
  });

  it("flags a ruling that supersedes itself", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000001" })];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    expect(result.findings.find((f) => f.code === "ruling_self_supersedes")).toBeDefined();
  });

  it("flags a ruling whose supersedes target does not exist", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000099" })];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    expect(result.findings.find((f) => f.code === "ruling_missing_supersedes_target")).toBeDefined();
  });

  it("flags a ruling whose supersedes target is unreadable, distinctly from a missing target", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000098" })];
    const state = makeState();
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(["r-0000000000000098"]),
      rulingScanCompleteness: "complete",
    });
    expect(result.findings.find((f) => f.code === "ruling_unreadable_supersedes_target")).toBeDefined();
    expect(result.findings.find((f) => f.code === "ruling_missing_supersedes_target")).toBeUndefined();
  });

  it("flags a supersedes cycle among rulings with the SAME code lessons use (generalized, gate-0 ruling)", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000002" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "supersedes_cycle");
    expect(finding).toBeDefined();
  });

  it("flags a supersedes branch (two rulings both superseding the same predecessor)", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000003", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "ruling_supersedes_branch");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("r-0000000000000001");
  });

  it("is a pure function: identical (state, now, aux) produces identical findings", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000099" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const aux = { rulings, unavailableRulingIds: new Set<string>(), rulingScanCompleteness: "complete" as const };
    const a = validateProject(state, "2026-08-27T00:00:00Z", aux);
    const b = validateProject(state, "2026-08-27T00:00:00Z", aux);
    expect(a).toEqual(b);
  });
});

describe("ruling reachability (T-494 scope 5)", () => {
  const COMPLETE = {
    unavailableRulingIds: new Set<string>(),
    rulingScanCompleteness: "complete" as const,
    rulingHasUnrecoverableEntries: false,
    citingEntityLoadComplete: true,
  };

  it("reports a current ruling that no ticket or issue cites, at info level", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, { rulings, ...COMPLETE });
    const finding = result.findings.find((f) => f.code === "unreachable_ruling");
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("info");
    expect(finding?.entity).toBe("r-0000000000000001");
    // Arrangements are off this function's input by T-473 binding item 2, so
    // the message must not claim more than tickets and issues were checked.
    expect(finding?.message).toContain("ticket or issue");
    // `info` must not affect validity. Asserting `result.valid === true` would
    // be wrong here: this synthetic fixture already carries unrelated errors,
    // so the honest check is that the reachability pass added no error of its
    // own, measured against the same state with no rulings aux at all.
    const baseline = validateProject(state);
    expect(result.errorCount).toBe(baseline.errorCount);
    expect(result.warningCount).toBe(baseline.warningCount);
    expect(result.infoCount).toBe(baseline.infoCount + 1);
  });

  it("does not report a current ruling that is cited", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, { rulings, ...COMPLETE });
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("does not report a SUPERSEDED ruling that nothing cites: being uncited is history's correct end state", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000002"] })] });
    const result = validateProject(state, undefined, { rulings, ...COMPLETE });
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("does not report a current ruling reached only THROUGH a stale citation", () => {
    // Reachability follows the chain to its tip. Raw set membership on cited
    // ids would call r-...02 dark even though every reader of T-1 is shown it.
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, { rulings, ...COMPLETE });
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("makes NO per-ruling claim when the RULING scan is incomplete, and says which half", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "incomplete",
      rulingHasUnrecoverableEntries: false,
      citingEntityLoadComplete: true,
    });
    const unknown = result.findings.filter((f) => f.code === "ruling_reachability_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.level).toBe("info");
    expect(unknown[0]?.entity).toBeNull();
    expect(unknown[0]?.message).toContain("ruling scan");
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("makes NO per-ruling claim when an individual ruling is unreadable", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(["r-0000000000000009"]),
      rulingScanCompleteness: "complete",
      rulingHasUnrecoverableEntries: false,
      citingEntityLoadComplete: true,
    });
    expect(result.findings.filter((f) => f.code === "ruling_reachability_unknown")).toHaveLength(1);
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("makes NO per-ruling claim when the CITING-ENTITY load dropped something, even with a complete ruling scan", () => {
    // This is the half a fixture covering only the ruling scan would pass
    // straight over. `loadProjectUnlocked` skips corrupt tickets and issues
    // with warnings, and validateRulings only ever sees the survivors -- so a
    // ruling whose sole citation lives in a skipped item would be reported as
    // cited by nothing.
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "complete",
      rulingHasUnrecoverableEntries: false,
      citingEntityLoadComplete: false,
    });
    const unknown = result.findings.filter((f) => f.code === "ruling_reachability_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("ticket and issue load");
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });

  it("emits exactly ONE unknown when BOTH halves are incomplete, naming both", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "incomplete",
      rulingHasUnrecoverableEntries: false,
      citingEntityLoadComplete: false,
    });
    const unknown = result.findings.filter((f) => f.code === "ruling_reachability_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("ruling scan");
    expect(unknown[0]?.message).toContain("ticket and issue load");
  });

  it("treats an ABSENT citingEntityLoadComplete as unknown, never as complete", () => {
    // Absence is never zero. A caller that does not assert completeness has
    // not established it, and defaulting to `true` here would be the exact
    // fail-open this check exists to close.
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1" })] });
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "complete",
      rulingHasUnrecoverableEntries: false,
    });
    expect(result.findings.filter((f) => f.code === "ruling_reachability_unknown")).toHaveLength(1);
    expect(result.findings.filter((f) => f.code === "unreachable_ruling")).toEqual([]);
  });
});

describe("ruling lifecycle (T-522)", () => {
  const acceptance = (payloadDigest: string) => ({
    attribution: "owner-direct" as const,
    recordedBy: { client: "claude", id: "test-session" },
    date: "2026-09-21",
    createdAt: "2026-09-21T00:00:00.000Z",
    payloadDigest,
  });
  const aux = (rulings: ReturnType<typeof makeRuling>[]) => ({
    rulings,
    unavailableRulingIds: new Set<string>(),
    rulingScanCompleteness: "complete" as const,
    citingEntityLoadComplete: true,
  });
  const codes = (r: ReturnType<typeof validateProject>) => r.findings.map((f) => f.code);

  it("flags a proposal carrying a supersedes edge with the classifier's own code", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", status: "proposed", supersedes: "r-0000000000000001", proposesToSupersede: "r-0000000000000001" }),
    ];
    const result = validateProject(makeState({}), undefined, aux(rulings));
    expect(codes(result)).toContain("ruling_proposed_with_supersedes");
    expect(result.findings.find((f) => f.code === "ruling_proposed_with_supersedes")?.level).toBe("error");
  });

  const findingOf = (r: ReturnType<typeof validateProject>, code: string) => r.findings.find((f) => f.code === code);

  it("flags status accepted without acceptance evidence", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", status: "accepted" })];
    const f = findingOf(validateProject(makeState({}), undefined, aux(rulings)), "ruling_status_without_acceptance");
    expect(f).toMatchObject({ level: "error", entity: "r-0000000000000001" });
    expect(f?.message).toContain("no acceptance record");
  });

  it("flags an accepted record whose digest no longer matches", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", status: "accepted", acceptance: acceptance("0".repeat(64)) })];
    const f = findingOf(validateProject(makeState({}), undefined, aux(rulings)), "ruling_acceptance_digest_mismatch");
    expect(f).toMatchObject({ level: "error", entity: "r-0000000000000001" });
    expect(f?.message).toContain("edited after acceptance");
  });

  it("flags a citation of a proposal as an error on the citing item, and does not also call it dangling", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", status: "proposed" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, aux(rulings));
    const f = findingOf(result, "ruling_citation_of_nonaccepted");
    expect(f).toMatchObject({ level: "error", entity: "T-1" });
    expect(f?.message).toContain("r-0000000000000001");
    expect(f?.message).toContain("proposed");
    expect(codes(result)).not.toContain("dangling_ruling_citation");
  });

  it("flags an accepted-legacy record superseding a proposal", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001", status: "proposed" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const f = findingOf(validateProject(makeState({}), undefined, aux(rulings)), "ruling_successor_of_nonaccepted");
    expect(f).toMatchObject({ level: "error", entity: "r-0000000000000002" });
    expect(f?.message).toContain("r-0000000000000001");
    expect(f?.message).toContain("proposed");
    expect(f?.message).not.toContain("never bound");
  });

  it("warns about a proposal aimed at an already-complete item", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", status: "proposed", proposedFor: ["T-1"] })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", status: "complete" })] });
    const finding = validateProject(state, undefined, aux(rulings)).findings.find((f) => f.code === "ruling_proposal_on_completed_item");
    expect(finding?.level).toBe("warning");
    expect(finding?.entity).toBe("r-0000000000000001");
  });

  it("produces no lifecycle finding on a legacy-only ledger", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" }), makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" })];
    const c = codes(validateProject(makeState({}), undefined, aux(rulings)));
    expect(c.filter((x) => x.startsWith("ruling_") && x !== "ruling_unreachable")).toEqual([]);
  });
});
