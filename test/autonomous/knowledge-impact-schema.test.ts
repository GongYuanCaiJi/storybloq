/**
 * T-527 (plan 3.5): the knowledge-impact report and the evidence cache schema.
 */
import { describe, expect, it } from "vitest";
import {
  KnowledgeEvidenceCacheSchema,
  KnowledgeImpactSchema,
} from "../../src/autonomous/session-types.js";

const SHA = "a".repeat(40);
const R1 = "r-0000000000000001";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { implementationCommit: SHA, maintenanceCommits: [], checked: ["cap-core"], outcome: "none", reason: "nothing changed", ...overrides };
}
function impact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { record: "cap-core", kind: "capability-changed", proposed: "refresh", disposition: "applied", evidence: { record: "cap-core" }, ...overrides };
}
function messages(value: unknown): string {
  const parsed = KnowledgeImpactSchema.safeParse(value);
  return parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; ");
}

describe("KnowledgeImpactSchema", () => {
  it("accepts none with a reason, and impacts with impacts", () => {
    expect(KnowledgeImpactSchema.safeParse(base()).success).toBe(true);
    expect(KnowledgeImpactSchema.safeParse(base({ outcome: "impacts", reason: undefined, impacts: [impact()] })).success).toBe(true);
    expect(KnowledgeImpactSchema.safeParse(base({ outcome: "uncertain", reason: "cannot tell" })).success).toBe(true);
  });

  it("refuses none or uncertain without a reason, and with impacts", () => {
    expect(messages(base({ reason: undefined }))).toContain("outcome none needs a reason");
    expect(messages(base({ outcome: "uncertain", reason: undefined }))).toContain("outcome uncertain needs a reason");
    expect(messages(base({ impacts: [impact()] }))).toContain("outcome none carries no impacts");
  });

  it("refuses impacts without impacts", () => {
    expect(messages(base({ outcome: "impacts", impacts: [] }))).toContain("at least one impact");
    expect(messages(base({ outcome: "impacts" }))).toContain("at least one impact");
  });

  it("refuses an empty checked list or a blank entry in it", () => {
    expect(messages(base({ checked: [] }))).toContain("checked must name what was inspected");
    expect(messages(base({ checked: [" "] }))).toContain("must not be blank");
  });

  it("requires full commit ids", () => {
    expect(KnowledgeImpactSchema.safeParse(base({ implementationCommit: SHA.slice(0, 12) })).success).toBe(false);
    expect(KnowledgeImpactSchema.safeParse(base({ maintenanceCommits: ["abc1234"] })).success).toBe(false);
  });

  it("requires evidence.record to equal the impact's record", () => {
    const bad = base({ outcome: "impacts", reason: undefined, impacts: [impact({ evidence: { record: "cap-other" } })] });
    expect(messages(bad)).toContain("evidence.record must equal the impact's record");
  });

  it("discriminates evidence by disposition", () => {
    const wrap = (i: Record<string, unknown>) => base({ outcome: "impacts", reason: undefined, impacts: [i] });
    expect(messages(wrap(impact({ evidence: { record: "cap-core", issueId: "ISS-1" } })))).toContain("issueId belongs to a pending disposition only");
    expect(messages(wrap(impact({ disposition: "pending", evidence: { record: "cap-core", issueId: "ISS-1" } })))).toBe("");
    const conflict = { record: R1, kind: "ruling-conflict", proposed: "supersede", disposition: "needs-decision" };
    expect(messages(wrap({ ...conflict, evidence: { record: R1 } }))).toContain("names its proposal");
    expect(messages(wrap({ ...conflict, evidence: { record: R1, proposalId: "r-0000000000000002" } }))).toBe("");
    expect(messages(wrap(impact({ evidence: { record: "cap-core", proposalId: "r-0000000000000002" } })))).toContain("proposalId belongs to a needs-decision");
  });

  it("refuses a record outside the four families, an unknown kind, and unknown fields", () => {
    const wrap = (i: Record<string, unknown>) => base({ outcome: "impacts", reason: undefined, impacts: [i] });
    expect(KnowledgeImpactSchema.safeParse(wrap(impact({ record: "T-001", evidence: { record: "T-001" } }))).success).toBe(false);
    expect(KnowledgeImpactSchema.safeParse(wrap(impact({ kind: "capability-renamed" }))).success).toBe(false);
    expect(KnowledgeImpactSchema.safeParse(base({ extra: 1 })).success).toBe(false);
    for (const record of ["term-duet", "N-12", "n-0000000000000001", R1]) {
      expect(KnowledgeImpactSchema.safeParse(wrap(impact({ record, evidence: { record } }))).success).toBe(true);
    }
  });
});

describe("KnowledgeEvidenceCacheSchema", () => {
  const cache = {
    version: 1,
    itemAttemptId: "legacy:T-001:abcdef12",
    implementationCommit: SHA,
    changedPaths: { paths: [{ status: "R", path: "b.ts", oldPath: "a.ts" }], disclosure: "committed changes since session start" },
    capabilities: [{ id: "cap-core", name: "Core", effectiveStatus: "current", reasons: ["path src"] }],
    stale: [],
    terms: [],
    rulings: [],
    truncated: { capabilities: false, stale: false, terms: false },
  };

  it("accepts a cache carrying both identities, or unavailable changed paths", () => {
    expect(KnowledgeEvidenceCacheSchema.safeParse(cache).success).toBe(true);
    expect(KnowledgeEvidenceCacheSchema.safeParse({ ...cache, changedPaths: { unavailable: "no initHead" } }).success).toBe(true);
  });

  it("refuses a cache without its identities or with another version", () => {
    const { itemAttemptId: _drop, ...noAttempt } = cache;
    expect(KnowledgeEvidenceCacheSchema.safeParse(noAttempt).success).toBe(false);
    expect(KnowledgeEvidenceCacheSchema.safeParse({ ...cache, implementationCommit: "abc" }).success).toBe(false);
    expect(KnowledgeEvidenceCacheSchema.safeParse({ ...cache, version: 2 }).success).toBe(false);
  });
});
