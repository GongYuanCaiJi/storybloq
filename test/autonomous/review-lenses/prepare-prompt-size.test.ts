/**
 * ISS-716 regression: handlePrepare must never blank a core lens prompt.
 *
 * The security lens has the largest fixed prompt of all lenses. With a real
 * RULES.md present (sliced to 2000 chars by the context packager) its assembled
 * prompt exceeds ~10.6k chars even with a tiny diff, so the previous
 * MAX_PROMPT_SIZE of 10_000 silently blanked it to "" with promptTruncated:true.
 * Security is a core, critical, always-active lens, so a blanked prompt means
 * the highest-severity reviewer is dispatched empty and the round can still
 * reach "approve". These tests assert every active lens (security included)
 * receives a non-empty prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePrepare } from "../../../src/autonomous/review-lenses/mcp-handlers.js";

let projectRoot: string;

const DIFF = `--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
+import { db } from "./db";
+
 export function handler(req) {
-  return "ok";
+  return db.query(req.params.id);
 }
`;

const CHANGED_FILES = ["src/api.ts"];

// A RULES.md longer than the 2000-char slice the context packager takes, so
// the assembled security prompt reflects a realistic project (this is what
// pushes it past the old 10_000 cap even with the tiny diff above).
const RULES = `# Development Rules\n\n` + "- Validate every external input before use; never trust request parameters.\n".repeat(60);

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "prepare-size-test-"));
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(
    join(projectRoot, "src", "api.ts"),
    `import { db } from "./db";\n\nexport function handler(req) {\n  return db.query(req.params.id);\n}\n`,
  );
  writeFileSync(join(projectRoot, "RULES.md"), RULES);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("handlePrepare prompt sizing (ISS-716)", () => {
  it("returns a non-empty, non-truncated prompt for every active lens", () => {
    const out = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      ticketDescription: "Add database query to handler",
      projectRoot,
    });

    expect(out.metadata.activeLenses).toContain("security");
    expect(out.lensPrompts.length).toBeGreaterThan(0);

    for (const lp of out.lensPrompts) {
      expect(lp.prompt, `lens ${lp.lens} prompt should not be blank`).not.toBe("");
      expect(lp.prompt.length, `lens ${lp.lens} prompt should be substantial`).toBeGreaterThan(100);
      expect(lp.promptTruncated, `lens ${lp.lens} should not be truncated`).toBe(false);
    }
  });

  it("does not blank the security lens whose prompt exceeds the old 10_000 cap", () => {
    const out = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      ticketDescription: "Add database query to handler",
      projectRoot,
    });

    const security = out.lensPrompts.find((lp) => lp.lens === "security");
    expect(security).toBeDefined();
    expect(security!.prompt).not.toBe("");
    expect(security!.promptTruncated).toBe(false);
    // The point of the regression: this prompt is larger than the old cap, so
    // under MAX_PROMPT_SIZE=10_000 it would have been blanked.
    expect(security!.prompt.length).toBeGreaterThan(10_000);
  });
});
