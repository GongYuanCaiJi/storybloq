import { describe, it, expect } from "vitest";
import { RulingSchema } from "../../src/models/ruling.js";
import { payloadDigest, classifyLifecycle } from "../../src/core/ruling-lifecycle.js";
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D, FIXTURE_E, FIXTURE_F, DIGEST_B, DIGEST_D, DIGEST_F } from "../fixtures/ruling-lifecycle-fixtures.js";

/**
 * T-522 plan section 1: every 1.16 record parses under the 1.16 schema; the
 * legacy record C parses with exactly the keys the 1.15 CLI wrote and is
 * classified accepted-legacy with NO acceptance evidence fabricated.
 *
 * RED against 236b9fc1: `src/core/ruling-lifecycle.js` does not exist and
 * `RulingSchema` declares none of these fields.
 */
describe("RulingSchema 1.16 fields", () => {
  it.each([
    ["A proposed", FIXTURE_A],
    ["B accepted with edge", FIXTURE_B],
    ["C legacy 1.15", FIXTURE_C],
    ["D accepted plain", FIXTURE_D],
    ["E withdrawn", FIXTURE_E],
    ["F direct supersede", FIXTURE_F],
  ])("parses fixture %s and keeps every field", (_name, fixture) => {
    const parsed = RulingSchema.parse(fixture);
    expect(parsed).toMatchObject(fixture);
  });

  it("rejects an unknown status value", () => {
    expect(RulingSchema.safeParse({ ...FIXTURE_D, status: "final" }).success).toBe(false);
  });

  it("legacy record C round-trips with exactly its own keys (no defaults injected for 1.16 fields)", () => {
    const parsed = RulingSchema.parse(FIXTURE_C);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(FIXTURE_C).sort());
    expect(parsed).toEqual(FIXTURE_C);
    expect("status" in parsed).toBe(false);
    expect("acceptance" in parsed).toBe(false);
  });
});

describe("payloadDigest", () => {
  it("matches the three plan constants", () => {
    expect(payloadDigest(RulingSchema.parse(FIXTURE_B))).toBe(DIGEST_B);
    expect(payloadDigest(RulingSchema.parse(FIXTURE_D))).toBe(DIGEST_D);
    expect(payloadDigest(RulingSchema.parse(FIXTURE_F))).toBe(DIGEST_F);
  });

  it("is the same for a proposal and its accepted form (one projection for every state)", () => {
    expect(payloadDigest(RulingSchema.parse(FIXTURE_A))).toBe(DIGEST_B);
  });

  it("collapses absent, null and [] for the edge and the item list", () => {
    const base = RulingSchema.parse(FIXTURE_D);
    const noFields = RulingSchema.parse({ ...FIXTURE_D, proposesToSupersede: undefined, proposedFor: undefined });
    expect(payloadDigest(noFields)).toBe(payloadDigest(base));
  });

  it("sorts and deduplicates scopeTags and proposedFor by code point", () => {
    const a = RulingSchema.parse({ ...FIXTURE_B, scopeTags: ["b", "a", "a"], proposedFor: ["T-9", "T-2", "T-2"] });
    const b = RulingSchema.parse({ ...FIXTURE_B, scopeTags: ["a", "b"], proposedFor: ["T-2", "T-9"] });
    expect(payloadDigest(a)).toBe(payloadDigest(b));
  });

  it("sorts by code point, pinned to an independently computed constant (Codex T1 minor)", () => {
    // sha256 over ["<A.text>","owner-direct",["Z","a"],"r-1111111111111111",["T-2","T-9"]],
    // computed outside this codebase. "Z" (0x5a) sorts before "a" (0x61):
    // a locale or descending sort produces a different constant.
    const MULTI = "98a231683bca84d4f079f3714abc4bd018729bf34da4ea01f09cffab1fe09f1f";
    for (const [tags, items] of [
      [["Z", "a"], ["T-2", "T-9"]],
      [["a", "Z", "a"], ["T-9", "T-2", "T-9"]],
    ] as const) {
      expect(payloadDigest(RulingSchema.parse({ ...FIXTURE_A, scopeTags: [...tags], proposedFor: [...items] }))).toBe(MULTI);
    }
  });

  it("binds attribution: changing only it changes the digest and quarantines an accepted record", () => {
    const MGR = "aff38e9e704ef48fbc02f997a805deab2395ee61dbd703fd46c1ccf26c0ccfbf";
    const changed = RulingSchema.parse({ ...FIXTURE_D, attribution: "manager-delegated" });
    expect(payloadDigest(changed)).toBe(MGR);
    expect(MGR).not.toBe(DIGEST_D);
    const c = classifyLifecycle(changed);
    expect(c.lifecycle).toBe("quarantined");
    expect(c.reasons.map((r) => r.code)).toEqual(["ruling_acceptance_digest_mismatch"]);
  });

  it("ignores recorder identity: changing only recordedBy keeps DIGEST_D", () => {
    const other = RulingSchema.parse({ ...FIXTURE_D, recordedBy: { client: "codex", id: "someone-else" } });
    expect(payloadDigest(other)).toBe(DIGEST_D);
  });

  it("keeps strings verbatim: a trailing space changes the digest", () => {
    const a = RulingSchema.parse(FIXTURE_D);
    const b = RulingSchema.parse({ ...FIXTURE_D, text: FIXTURE_D.text + " " });
    expect(payloadDigest(a)).not.toBe(payloadDigest(b));
  });

  it("ignores narrative, date, recordedBy and createdAt", () => {
    const a = RulingSchema.parse(FIXTURE_D);
    const b = RulingSchema.parse({ ...FIXTURE_D, narrative: { context: "x" }, date: "2020-01-01", createdAt: "2020-01-01T00:00:00.000Z" });
    expect(payloadDigest(a)).toBe(payloadDigest(b));
  });
});

describe("classifyLifecycle", () => {
  it("classifies the fixtures", () => {
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_A)).lifecycle).toBe("proposed");
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_B)).lifecycle).toBe("accepted");
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_C)).lifecycle).toBe("accepted-legacy");
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_D)).lifecycle).toBe("accepted");
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_E)).lifecycle).toBe("withdrawn");
    expect(classifyLifecycle(RulingSchema.parse(FIXTURE_F)).lifecycle).toBe("accepted");
  });

  it("never fabricates acceptance for a legacy record", () => {
    const c = classifyLifecycle(RulingSchema.parse(FIXTURE_C));
    expect(c.lifecycle).toBe("accepted-legacy");
    expect(c.reasons).toEqual([]);
  });

  it("quarantines a proposal carrying a supersedes edge (the 1.15 hazard)", () => {
    const c = classifyLifecycle(RulingSchema.parse({ ...FIXTURE_A, supersedes: "r-1111111111111111" }));
    expect(c.lifecycle).toBe("quarantined");
    expect(c.reasons.map((r) => r.code)).toContain("ruling_proposed_with_supersedes");
  });

  it("quarantines a withdrawn record carrying a supersedes edge", () => {
    const c = classifyLifecycle(RulingSchema.parse({ ...FIXTURE_E, supersedes: "r-1111111111111111" }));
    expect(c.lifecycle).toBe("quarantined");
  });

  it("quarantines status accepted without acceptance evidence", () => {
    const { acceptance: _a, ...noAcceptance } = FIXTURE_D;
    const c = classifyLifecycle(RulingSchema.parse(noAcceptance));
    expect(c.lifecycle).toBe("quarantined");
    expect(c.reasons.map((r) => r.code)).toContain("ruling_status_without_acceptance");
  });

  it("quarantines an accepted record edited after acceptance (digest mismatch)", () => {
    const c = classifyLifecycle(RulingSchema.parse({ ...FIXTURE_D, text: "Redaction is never skipped." }));
    expect(c.lifecycle).toBe("quarantined");
    expect(c.reasons.map((r) => r.code)).toContain("ruling_acceptance_digest_mismatch");
  });

  it.each([
    ["added", { ...FIXTURE_D, supersedes: "r-1111111111111111" }],
    ["removed", { ...FIXTURE_B, supersedes: null }],
    ["changed", { ...FIXTURE_F, supersedes: "r-9999999999999999" }],
  ])("quarantines an accepted record whose supersedes was %s after acceptance", (_w, fixture) => {
    const c = classifyLifecycle(RulingSchema.parse(fixture));
    expect(c.lifecycle).toBe("quarantined");
    expect(c.reasons.map((r) => r.code)).toContain("ruling_acceptance_edge_mismatch");
  });

  it.each([
    ["legacy", FIXTURE_C],
    ["proposed", FIXTURE_A],
    ["withdrawn", FIXTURE_E],
    ["accepted", FIXTURE_D],
    ["accepted without evidence", { ...FIXTURE_D, acceptance: undefined }],
    ["digest-mismatched", { ...FIXTURE_D, text: "edited" }],
    ["proposal with edge", { ...FIXTURE_A, supersedes: "r-1111111111111111" }],
  ])("classifies a %s record carrying conflict entries as conflicted, with no reasons, before any other branch", (_n, fixture) => {
    const c = classifyLifecycle(
      RulingSchema.parse({
        ...fixture,
        _conflicts: [{ fieldPath: "lifecycle", kind: "coupled", group: "lifecycle", base: null, ours: null, theirs: null }],
      }),
    );
    expect(c).toEqual({ lifecycle: "conflicted", reasons: [] });
  });
});
