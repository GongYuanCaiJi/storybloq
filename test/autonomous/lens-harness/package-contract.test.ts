/**
 * ISS-823 contract tests for the @storybloq/lenses dependency.
 *
 * The autonomous lens backend consumes the package's stable 0.3.0 library
 * surface (lenses T-033). These tests pin the exact exports the consumer
 * harness relies on, so a package upgrade that breaks the contract fails
 * here first with a named symbol rather than deep inside the harness.
 */

import { describe, it, expect } from "vitest";
import {
  LENSES,
  SURFACE_RULES,
  activate,
  buildLensPrompt,
  runMergerPipeline,
  LensOutputSchema,
  LensFindingSchema,
  ReviewVerdictSchema,
  MergerConfigSchema,
  PreambleConfigSchema,
  DEFAULT_ALWAYS_BLOCK,
  COVERED_STATUSES,
} from "@storybloq/lenses";

describe("@storybloq/lenses stable library surface (ISS-823)", () => {
  it("exports the 9-lens frozen registry projection", () => {
    const ids = Object.keys(LENSES).sort();
    expect(ids).toEqual([
      "accessibility",
      "api-design",
      "clean-code",
      "concurrency",
      "data-safety",
      "error-handling",
      "performance",
      "security",
      "test-quality",
    ]);
    // Mutability boundary: registry projections are frozen.
    expect(Object.isFrozen(LENSES)).toBe(true);
    expect(Object.isFrozen(SURFACE_RULES)).toBe(true);
    // Every lens carries a version used in consumer cache keys.
    for (const id of ids) {
      expect(LENSES[id as keyof typeof LENSES].version).toBeTruthy();
    }
  });

  it("activate() fires all four core lenses for a plain TS code review", () => {
    const activations = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/example.ts"],
    });
    const active = activations.map((a) => a.lensId);
    for (const core of ["security", "error-handling", "clean-code", "concurrency"]) {
      expect(active).toContain(core);
    }
  });

  it("buildLensPrompt() produces a self-contained prompt embedding the artifact", () => {
    const [first] = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/example.ts"],
    });
    const prompt = buildLensPrompt({
      activation: first!,
      startParams: {
        stage: "CODE_REVIEW",
        changedFiles: ["src/example.ts"],
        artifact: "diff --git a/src/example.ts b/src/example.ts\n+const x = 1;",
        ticketDescription: "contract test",
        reviewRound: 1,
        priorDeferrals: [],
      },
      preambleConfig: PreambleConfigSchema.parse({}),
    });
    expect(prompt.lensId).toBe(first!.lensId);
    expect(prompt.prompt).toContain("const x = 1;");
    expect(prompt.prompt).toContain("## Output rules");
  });

  it("runMergerPipeline() returns a schema-valid ReviewVerdict", () => {
    const finding = {
      id: "f-1",
      severity: "major" as const,
      category: "unchecked-error",
      file: "src/example.ts",
      line: 1,
      description: "example finding",
      suggestion: "fix it",
      confidence: 0.9,
    };
    const verdict = runMergerPipeline({
      reviewId: "r-contract",
      sessionId: "s-contract",
      perLens: [
        {
          lensId: "error-handling",
          output: { status: "ok", findings: [finding], error: null, notes: null },
        },
      ],
      lensCoverage: [
        { lensId: "error-handling", status: "ok", attempts: 1, contributedFindings: 1 },
      ],
      reviewComplete: true,
    });
    const parsed = ReviewVerdictSchema.parse(verdict);
    expect(parsed.verdict).toBe("revise");
    expect(parsed.major).toBe(1);
    expect(parsed.coverage).toBe("full");
  });

  it("blocking severity forces reject and hardcoded-secrets is alwaysBlock", () => {
    expect(DEFAULT_ALWAYS_BLOCK).toContain("hardcoded-secrets");
    expect(COVERED_STATUSES.has("ok")).toBe(true);
    expect(COVERED_STATUSES.has("cached")).toBe(true);
    const verdict = runMergerPipeline({
      reviewId: "r-blocking",
      sessionId: "s-blocking",
      perLens: [
        {
          lensId: "security",
          output: {
            status: "ok",
            findings: [
              {
                id: "sec-1",
                severity: "blocking",
                category: "hardcoded-secrets",
                file: null,
                line: null,
                description: "secret detected",
                suggestion: "remove it",
                confidence: 0.9,
              },
            ],
            error: null,
            notes: null,
          },
        },
      ],
      reviewComplete: true,
    });
    expect(verdict.verdict).toBe("reject");
    expect(verdict.blocking).toBe(1);
  });

  it("LensOutputSchema and LensFindingSchema enforce the wire contract", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "ok",
        findings: [],
        error: null,
        notes: null,
      }).success,
    ).toBe(true);
    // Fork-shaped finding (evidence[], suggestedFix, critical severity) must
    // NOT parse: the fork schema survives nowhere (pen ruling R1).
    expect(
      LensFindingSchema.safeParse({
        lens: "security",
        lensVersion: "v1",
        severity: "critical",
        recommendedImpact: "blocker",
        category: "x",
        description: "y",
        file: null,
        line: null,
        evidence: [{ file: "a.ts", startLine: 1, endLine: 1, code: "z" }],
        suggestedFix: null,
        confidence: 0.9,
        assumptions: null,
        requiresMoreContext: false,
      }).success,
    ).toBe(false);
    expect(MergerConfigSchema.parse(undefined).confidenceFloor).toBe(0.6);
  });
});
