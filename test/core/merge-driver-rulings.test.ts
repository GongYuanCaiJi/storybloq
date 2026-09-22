import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { getMergeRules, getCoupledGroups } from "../../src/core/field-classification.js";
import { resolveConflicts } from "../../src/core/resolve.js";
import { RulingSchema, type Ruling } from "../../src/models/ruling.js";
import { classifyLifecycle, lifecycleOf, payloadDigest, makeAcceptance } from "../../src/core/ruling-lifecycle.js";
import { buildSuccessorIndex, buildCitationResolutionContext, resolveCitation } from "../../src/core/ruling.js";

/**
 * T-522 plan section 8 (P-3): merge integrity for ruling records.
 *
 * The whole reviewed payload is ONE coupled group (`lifecycle`): when both
 * sides changed any member and the sides differ, the driver keeps OURS as a
 * complete side and records the group's conflict so `resolve --use ours|theirs`
 * swaps the WHOLE side. Never "rev 2 + A's acceptance", never a silent pick.
 * Narrative is commentary: latest-wins, never blocking.
 *
 * RED against ab0fab1b: EntityType has no "ruling"; getMergeRules("ruling")
 * is {}; every divergent field is a plain field conflict and the body is the
 * BASE per field (a proposed rev-1 body with no acceptance is safe by accident,
 * but a legacy-vs-accepted divergence would mix members).
 */
const BY = { client: "claude", id: "aaa3eb21" };

function proposal(over: Partial<Ruling> = {}): Record<string, unknown> {
  return {
    id: "r-2222222222222222",
    text: "Background work carries the request id of the job that enqueued it",
    attribution: "owner-direct",
    recordedBy: BY,
    date: "2026-09-21",
    scopeTags: ["logging"],
    supersedes: null,
    createdAt: "2026-09-21T10:00:00.000Z",
    status: "proposed",
    proposesToSupersede: "r-1111111111111111",
    proposedFor: ["T-2"],
    ...over,
  };
}

function accepted(base: Record<string, unknown>): Record<string, unknown> {
  const r = RulingSchema.parse(base);
  return {
    ...base,
    status: "accepted",
    supersedes: r.proposesToSupersede ?? null,
    acceptance: makeAcceptance(r, { attribution: "owner-direct", recordedBy: BY, date: "2026-09-22" }, "2026-09-22T09:00:00.000Z"),
  };
}

describe("T-522: ruling field classification", () => {
  it("the reviewed payload is one coupled group; narrative is latest-wins; identity fields are identity", () => {
    const rules = getMergeRules("ruling");
    for (const k of ["id", "createdAt", "recordedBy"]) expect(rules[k]).toEqual({ kind: "identity" });
    const members = ["status", "text", "attribution", "date", "scopeTags", "supersedes", "proposesToSupersede", "proposedFor", "acceptance", "withdrawal"];
    for (const m of members) {
      expect(rules[m]?.kind, m).toBe("coupled");
      expect((rules[m] as { group: string }).group).toBe("lifecycle");
    }
    expect(rules.narrative?.kind).toBe("latest-wins");
    const groups = getCoupledGroups("ruling");
    expect(groups.map((g) => g.group)).toEqual(["lifecycle"]);
    expect([...groups[0]!.members].sort()).toEqual([...members].sort());
    // The symmetric-group invariant every other entity type honours.
    for (const m of groups[0]!.members) expect((rules[m] as { group: string }).group).toBe("lifecycle");
  });
});

describe("T-522 P-3: threeWayMerge over rulings", () => {
  it("A accepts rev 1, B edits to rev 2: ours kept WHOLE, one coupled group conflict, lifecycle conflicted, never rev 2 + acceptance", () => {
    const base = proposal();
    const ours = accepted(base);
    const theirs = proposal({ text: "Background work carries the request id of the job that enqueued it, and its retry count" });
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(false);
    // Body is OUR side, whole.
    expect(result.merged.text).toBe(base.text);
    expect(result.merged.status).toBe("accepted");
    expect(result.merged.supersedes).toBe("r-1111111111111111");
    expect(result.merged.acceptance).toEqual(ours.acceptance);
    // The conflict is the lifecycle group, carrying theirs whole for resolve.
    const groupEntries = result.conflicts.filter((c) => c.kind === "coupled" && c.group === "lifecycle");
    expect(groupEntries.length).toBeGreaterThan(0);
    expect(groupEntries.every((c) => c.kind === "coupled")).toBe(true);
    expect(result.conflicts.every((c) => c.kind === "coupled" && c.group === "lifecycle")).toBe(true);
    const textEntry = groupEntries.find((c) => c.field === "text")!;
    expect(textEntry.ours).toBe(base.text);
    expect(textEntry.theirs).toBe(theirs.text);
    // The merged record parses, is conflicted, and binds nothing.
    const parsed = RulingSchema.parse(result.merged);
    expect(classifyLifecycle(parsed).lifecycle).toBe("conflicted");
    const index = buildSuccessorIndex([parsed]);
    expect(index.successorsByTarget.get("r-1111111111111111")).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get("r-1111111111111111")).toEqual([parsed.id]);
    // The digest inside the kept acceptance still matches the kept payload:
    // the merge produced a coherent side, not a mixture.
    expect(parsed.acceptance!.payloadDigest).toBe(payloadDigest(parsed));
  });

  it("the mirror orientation (ours edited, theirs accepted) keeps OUR edit whole and never carries their acceptance onto it", () => {
    const base = proposal();
    const ours = proposal({ text: "rev 2 text" });
    const theirs = accepted(base);
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(false);
    expect(result.merged.text).toBe("rev 2 text");
    expect(result.merged.status).toBe("proposed");
    expect(result.merged.acceptance).toBeUndefined();
    expect(result.merged.supersedes).toBeNull();
    expect("acceptance" in result.merged).toBe(false);
    expect(classifyLifecycle(RulingSchema.parse(result.merged)).lifecycle).toBe("conflicted");
  });

  it("resolve --use theirs restores THEIR side whole (accepted rev 1); --use ours keeps the edit; both coherent", () => {
    const base = proposal();
    const ours = proposal({ text: "rev 2 text" });
    const theirs = accepted(base);
    const merged = threeWayMerge(base, ours, theirs, "ruling").merged as Record<string, unknown>;

    const takeTheirs = { ...merged };
    const r1 = resolveConflicts(takeTheirs, { use: "theirs" });
    expect(r1.fullyResolved).toBe(true);
    const t = RulingSchema.parse(JSON.parse(JSON.stringify(takeTheirs)));
    expect(t.text).toBe(base.text);
    expect(t.status).toBe("accepted");
    expect(t.acceptance!.payloadDigest).toBe(payloadDigest(t));
    expect(classifyLifecycle(t).lifecycle).toBe("accepted");

    const takeOurs = { ...merged };
    const r2 = resolveConflicts(takeOurs, { use: "ours" });
    expect(r2.fullyResolved).toBe(true);
    const o = RulingSchema.parse(JSON.parse(JSON.stringify(takeOurs)));
    expect(o.text).toBe("rev 2 text");
    expect(o.status).toBe("proposed");
    expect(o.acceptance).toBeUndefined();
    expect(classifyLifecycle(o).lifecycle).toBe("proposed");
  });

  it("--value is refused on the lifecycle group: a ruling's payload is one reviewed unit", () => {
    const base = proposal();
    const merged = threeWayMerge(base, proposal({ text: "x" }), accepted(base), "ruling").merged as Record<string, unknown>;
    expect(() => resolveConflicts({ ...merged }, { field: "text", value: "hand-picked" })).toThrow(/coupled group/);
  });

  it("narrative-only divergence merges clean (latest-wins keeps ours on a tie) and the record stays accepted", () => {
    const base = accepted(proposal());
    const ours = { ...base, narrative: { context: "ours says" } };
    const theirs = { ...base, narrative: { context: "theirs says" } };
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(true);
    expect(result.merged.narrative).toEqual({ context: "ours says" });
    expect(classifyLifecycle(RulingSchema.parse(result.merged)).lifecycle).toBe("accepted");
  });

  it("one-sided acceptance merges clean; identical acceptances on both sides merge clean", () => {
    const base = proposal();
    const acc = accepted(base);
    const oneSided = threeWayMerge(base, acc, base, "ruling");
    expect(oneSided.clean).toBe(true);
    expect(oneSided.merged.status).toBe("accepted");
    const same = threeWayMerge(base, acc, { ...acc }, "ruling");
    expect(same.clean).toBe(true);
    expect(same.merged.acceptance).toEqual(acc.acceptance);
  });

  it("two branches accepting P and Q against R1 are separate files: both merge clean and the index reports the branch, picking neither", () => {
    const r1 = RulingSchema.parse({
      id: "r-1111111111111111", text: "R1", attribution: "owner-direct", recordedBy: BY, date: "2026-09-01",
      scopeTags: [], supersedes: null, createdAt: "2026-09-01T00:00:00.000Z",
    });
    const p = RulingSchema.parse(accepted(proposal()));
    const q = RulingSchema.parse(accepted(proposal({ id: "r-3333333333333333", text: "Q" })));
    const index = buildSuccessorIndex([r1, p, q]);
    expect(index.branchedTargets.has(r1.id)).toBe(true);
    const ctx = buildCitationResolutionContext([r1, p, q], new Set(), "complete", false);
    expect(resolveCitation(r1.id, ctx).status).toBe("branch");
    expect(lifecycleOf(p, index)).toBe("accepted");
    expect(lifecycleOf(q, index)).toBe("accepted");
  });

  it("a conflicted record in the successor position makes its target's chain indeterminate, not current and not superseded", () => {
    const r1 = RulingSchema.parse({
      id: "r-1111111111111111", text: "R1", attribution: "owner-direct", recordedBy: BY, date: "2026-09-01",
      scopeTags: [], supersedes: null, createdAt: "2026-09-01T00:00:00.000Z",
    });
    const base = proposal();
    const merged = RulingSchema.parse(threeWayMerge(base, accepted(base), proposal({ text: "x" }), "ruling").merged);
    const ctx = buildCitationResolutionContext([r1, merged], new Set(), "complete", false);
    const res = resolveCitation(r1.id, ctx);
    expect(res.status).toBe("indeterminate");
    expect(resolveCitation(merged.id, ctx).status).toBe("nonaccepted");
  });

  it("reverse fixture: OURS accepted, THEIRS edited; --use theirs yields the edit with NO acceptance key (checked before serialisation)", () => {
    const base = proposal();
    const ours = accepted(base);
    const theirs = proposal({ text: "rev 2 text" });
    const merged = threeWayMerge(base, ours, theirs, "ruling").merged as Record<string, unknown>;
    expect(merged.acceptance).toEqual(ours.acceptance);
    const take = { ...merged };
    expect(resolveConflicts(take, { use: "theirs" }).fullyResolved).toBe(true);
    expect(take.text).toBe("rev 2 text");
    expect(take.status).toBe("proposed");
    expect(take.supersedes).toBeNull();
    expect(Object.hasOwn(take, "acceptance")).toBe(false);
    expect(classifyLifecycle(RulingSchema.parse(take)).lifecycle).toBe("proposed");
  });

  it("withdrawal on one side versus an edit on the other: the whole side is kept, and --use swaps the withdrawal in or out entirely", () => {
    const base = proposal();
    const ours = { ...base, status: "withdrawn", withdrawal: { recordedBy: BY, createdAt: "2026-09-22T09:00:00.000Z", reason: "no longer needed" } };
    const theirs = proposal({ text: "rev 2 text" });
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(false);
    expect(result.merged.status).toBe("withdrawn");
    expect(result.merged.withdrawal).toEqual(ours.withdrawal);
    expect(result.merged.text).toBe(base.text);
    expect(classifyLifecycle(RulingSchema.parse(result.merged)).lifecycle).toBe("conflicted");
    const take = { ...result.merged } as Record<string, unknown>;
    expect(resolveConflicts(take, { use: "theirs" }).fullyResolved).toBe(true);
    expect(take.text).toBe("rev 2 text");
    expect(take.status).toBe("proposed");
    expect(Object.hasOwn(take, "withdrawal")).toBe(false);
    expect(classifyLifecycle(RulingSchema.parse(take)).lifecycle).toBe("proposed");
  });

  it("divergent scopeTags arrays are one side or the other, never a union", () => {
    const base = proposal();
    const ours = proposal({ scopeTags: ["logging", "queue"] });
    const theirs = proposal({ scopeTags: ["logging", "tracing"] });
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(false);
    expect(result.merged.scopeTags).toEqual(["logging", "queue"]);
    const take = { ...result.merged } as Record<string, unknown>;
    resolveConflicts(take, { use: "theirs" });
    expect(take.scopeTags).toEqual(["logging", "tracing"]);
  });

  it("two DISTINCT accepted revisions of the same record: each side is coherent on its own, the body is ours, --use theirs is the other whole", () => {
    const base = proposal();
    const ours = accepted(base);
    const theirs = accepted(proposal({ text: "rev 2 text" }));
    expect((ours.acceptance as { payloadDigest: string }).payloadDigest).not.toBe((theirs.acceptance as { payloadDigest: string }).payloadDigest);
    const result = threeWayMerge(base, ours, theirs, "ruling");
    expect(result.clean).toBe(false);
    const kept = RulingSchema.parse(result.merged);
    expect(kept.text).toBe(base.text);
    expect(kept.acceptance).toEqual(ours.acceptance);
    expect(kept.acceptance!.payloadDigest).toBe(payloadDigest(kept));
    expect(classifyLifecycle(kept).lifecycle).toBe("conflicted");
    const take = { ...result.merged } as Record<string, unknown>;
    expect(resolveConflicts(take, { use: "theirs" }).fullyResolved).toBe(true);
    const other = RulingSchema.parse(JSON.parse(JSON.stringify(take)));
    expect(other.text).toBe("rev 2 text");
    expect(other.acceptance).toEqual(theirs.acceptance);
    expect(other.acceptance!.payloadDigest).toBe(payloadDigest(other));
    expect(classifyLifecycle(other).lifecycle).toBe("accepted");
  });
});
