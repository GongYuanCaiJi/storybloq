import { describe, it, expect } from "vitest";
import { detectBranchAffinity, checkAffinityMismatch, buildAffinityAnnotation, buildMismatchHandoverInstruction } from "../../src/autonomous/branch-affinity.js";

describe("detectBranchAffinity", () => {
  it("returns none for null branch", () => {
    const result = detectBranchAffinity(null);
    expect(result.status).toBe("none");
    expect(result.matchedIds).toEqual([]);
  });

  it("returns none for protected branches", () => {
    for (const branch of ["main", "master", "develop", "dev", "staging", "production"]) {
      const result = detectBranchAffinity(branch);
      expect(result.status).toBe("none");
    }
  });

  it("returns none for branches with no entity ID", () => {
    expect(detectBranchAffinity("feature/some-work").status).toBe("none");
    expect(detectBranchAffinity("bugfix/crash-on-load").status).toBe("none");
    expect(detectBranchAffinity("release/v2.0").status).toBe("none");
  });

  it("detects ticket ID in story/ prefix", () => {
    const result = detectBranchAffinity("story/T-012-rebrand");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-012"]);
  });

  it("detects ticket ID in feature/ prefix", () => {
    const result = detectBranchAffinity("feature/foo-T-123-bar");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-123"]);
  });

  it("detects issue ID in fix/ prefix", () => {
    const result = detectBranchAffinity("fix/ISS-077-crash");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["ISS-077"]);
  });

  it("detects bare ticket ID", () => {
    const result = detectBranchAffinity("T-012-slug");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-012"]);
  });

  it("detects ticket with letter suffix preserving case", () => {
    const result = detectBranchAffinity("story/T-012a-rebrand");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-012a"]);
  });

  it("handles case-insensitive matching and normalizes prefix", () => {
    const result = detectBranchAffinity("fix/iss-077-crash");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["ISS-077"]);
  });

  it("returns ambiguous for multiple distinct IDs", () => {
    const result = detectBranchAffinity("feature/T-012-and-T-013");
    expect(result.status).toBe("ambiguous");
    expect(result.matchedIds).toContain("T-012");
    expect(result.matchedIds).toContain("T-013");
  });

  it("does not treat duplicate IDs as ambiguous", () => {
    const result = detectBranchAffinity("story/T-012-T-012-retry");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-012"]);
  });

  it("handles underscore delimiters", () => {
    const result = detectBranchAffinity("feature_T-100_work");
    expect(result.status).toBe("matched");
    expect(result.matchedIds).toEqual(["T-100"]);
  });

  it("does not match IDs embedded without delimiter", () => {
    const result = detectBranchAffinity("featureT-100work");
    expect(result.status).toBe("none");
  });
});

describe("checkAffinityMismatch", () => {
  it("never blocks for none status", () => {
    const affinity = { status: "none" as const, matchedIds: [], branch: "main" };
    expect(checkAffinityMismatch(affinity, "T-100").blocked).toBe(false);
  });

  it("never blocks for ambiguous status", () => {
    const affinity = { status: "ambiguous" as const, matchedIds: ["T-012", "T-013"], branch: "feature/T-012-and-T-013" };
    expect(checkAffinityMismatch(affinity, "T-999").blocked).toBe(false);
  });

  it("does not block when pick matches branch entity", () => {
    const affinity = { status: "matched" as const, matchedIds: ["T-123"], branch: "story/T-123-foo" };
    expect(checkAffinityMismatch(affinity, "T-123").blocked).toBe(false);
  });

  it("blocks when pick does not match branch entity", () => {
    const affinity = { status: "matched" as const, matchedIds: ["T-123"], branch: "story/T-123-foo" };
    const result = checkAffinityMismatch(affinity, "T-456");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("T-123");
    expect(result.reason).toContain("T-456");
  });

  it("normalizes case for comparison", () => {
    const affinity = { status: "matched" as const, matchedIds: ["ISS-077"], branch: "fix/ISS-077-crash" };
    expect(checkAffinityMismatch(affinity, "iss-077").blocked).toBe(false);
  });

  it("blocks issue pick on ticket branch", () => {
    const affinity = { status: "matched" as const, matchedIds: ["T-123"], branch: "story/T-123-foo" };
    const result = checkAffinityMismatch(affinity, "ISS-050");
    expect(result.blocked).toBe(true);
  });
});

describe("buildAffinityAnnotation", () => {
  it("returns null for none status", () => {
    const result = buildAffinityAnnotation({ status: "none", matchedIds: [], branch: null });
    expect(result.warningText).toBeNull();
  });

  it("returns affinity text for matched status", () => {
    const result = buildAffinityAnnotation({ status: "matched", matchedIds: ["T-123"], branch: "story/T-123-foo" });
    expect(result.warningText).toContain("[Branch affinity]");
    expect(result.warningText).toContain("T-123");
  });

  it("returns warning text for ambiguous status", () => {
    const result = buildAffinityAnnotation({ status: "ambiguous", matchedIds: ["T-012", "T-013"], branch: "feature/T-012-and-T-013" });
    expect(result.warningText).toContain("[Branch warning]");
    expect(result.warningText).toContain("T-012");
    expect(result.warningText).toContain("T-013");
  });
});

describe("buildMismatchHandoverInstruction", () => {
  it("includes branch name and attempted pick", () => {
    const affinity = { status: "matched" as const, matchedIds: ["T-123"], branch: "story/T-123-foo" };
    const result = buildMismatchHandoverInstruction(affinity, "T-456", "test-session-id");
    expect(result).toContain("T-456");
    expect(result).toContain("story/T-123-foo");
    expect(result).toContain("T-123");
    expect(result).toContain("test-session-id");
  });

  it("includes actionable alternatives", () => {
    const affinity = { status: "matched" as const, matchedIds: ["T-123"], branch: "story/T-123-foo" };
    const result = buildMismatchHandoverInstruction(affinity, "T-456", "sid");
    expect(result).toContain("/story auto T-456");
    expect(result).toContain("branchStrategy");
  });
});
