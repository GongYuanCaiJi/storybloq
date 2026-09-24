/**
 * T-531: the stage label table the ledger dashboard draws on the in-progress
 * card and in the session footer.
 *
 * The Mod cannot import `src/` at runtime (the plugin ships only
 * `plugins/storybloq/`), so `stage-label.ts` carries its own table and its own
 * copy of the stale threshold. These tests are what hold both to `src`: a new
 * guide state fails the exhaustiveness check until it has a label, and a
 * retuned presence TTL fails the threshold check until the copy follows.
 */
import { describe, it, expect } from "vitest";
import { WORKFLOW_STATES } from "../../src/autonomous/session-types.js";
import { PRESENCE_TTL_MS } from "../../src/presence/types.js";
import {
  STAGE_LABELS,
  STAGE_STALE_MS,
  displaySafe,
  stageLabel,
  stageStale,
} from "../../plugins/storybloq/hooks/stage-label.js";

describe("T-531 stage labels", () => {
  it("labels every member of the guide's state union explicitly, and nothing else", () => {
    for (const state of WORKFLOW_STATES) {
      expect(Object.hasOwn(STAGE_LABELS, state), state).toBe(true);
      expect(STAGE_LABELS[state]!.trim().length, state).toBeGreaterThan(0);
    }
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...WORKFLOW_STATES].sort());
  });

  it("uses exactly the labels the ticket names", () => {
    expect(STAGE_LABELS).toEqual({
      PLAN: "Planning",
      PLAN_REVIEW: "Plan review",
      WRITE_TESTS: "Writing tests",
      IMPLEMENT: "Implementing",
      TEST: "Testing",
      CODE_REVIEW: "Code review",
      BUILD: "Building",
      VERIFY: "Verifying",
      FINALIZE: "Finalizing",
      KNOWLEDGE_REVIEW: "Knowledge review",
      COMPACT: "Compacting",
      LESSON_CAPTURE: "Lessons",
      ISSUE_FIX: "Fixing issue",
      ISSUE_SWEEP: "Issue sweep",
      PICK_TICKET: "Picking",
      LOAD_CONTEXT: "Loading",
      INIT: "Starting",
      HANDOVER: "Handover",
      COMPLETE: "Complete",
      SESSION_END: "Ended",
    });
    expect(Object.isFrozen(STAGE_LABELS)).toBe(true);
  });

  it("maps a known state through the table", () => {
    expect(stageLabel("IMPLEMENT")).toBe("Implementing");
    expect(stageLabel("PLAN_REVIEW")).toBe("Plan review");
  });

  it("falls back to the raw state, lowercased with spaces, never blank", () => {
    expect(stageLabel("NEW_STATE")).toBe("new state");
    expect(stageLabel("Weird")).toBe("weird");
    expect(stageLabel("_EDGE_")).toBe("edge");
    // The table is looked up by own property: an inherited member is not a label.
    expect(stageLabel("constructor")).toBe("constructor");
    expect(stageLabel("__proto__")).toBe("proto");
    expect(stageLabel("toString")).toBe("tostring");
    expect(stageLabel("___")).toBe("unknown");
    expect(stageLabel("")).toBe("unknown");
  });

  it("never lets a control sequence through the fallback", () => {
    const label = stageLabel("EVIL\u001b]0;title\u0007_STATE");
    expect(label).toBe("evil ]0;title state");
    expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("T-531 display safety", () => {
  it("turns every unsafe run into one space and trims", () => {
    expect(displaySafe("a\u001b[31mb")).toBe("a [31mb");
    expect(displaySafe("a\u0007b")).toBe("a b");
    expect(displaySafe("a\tb")).toBe("a b");
    expect(displaySafe("a\r\nb")).toBe("a b");
    expect(displaySafe("a\u007fb")).toBe("a b");
    expect(displaySafe("a\u0085b\u009bc")).toBe("a b c");
    expect(displaySafe("a\u2028b\u2029c")).toBe("a b c");
    expect(displaySafe("a\u202eb\u2066c\u2069d")).toBe("a b c d");
    expect(displaySafe("\u001b\u001b T-001 \n")).toBe("T-001");
    expect(displaySafe("\u0000\u0001")).toBe("");
  });

  it("leaves a safe string exactly as it was", () => {
    for (const text of ["T-001", "Implementing", "Plan review", "ISS-12", "naïve 日本 ✓"]) {
      expect(displaySafe(text)).toBe(text);
    }
  });
});

describe("T-531 stale threshold", () => {
  it("is the presence TTL the presence handler sweeps with", () => {
    expect(STAGE_STALE_MS).toBe(PRESENCE_TTL_MS);
  });

  it("is stale only past the threshold, never for a future or unreadable stamp", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    const at = (ms: number) => new Date(ms).toISOString();
    expect(stageStale(at(now - STAGE_STALE_MS), now)).toBe(false);
    expect(stageStale(at(now - STAGE_STALE_MS - 1), now)).toBe(true);
    expect(stageStale(at(now - 1000), now)).toBe(false);
    expect(stageStale(at(now + 60_000), now)).toBe(false);
    expect(stageStale("not a date", now)).toBe(false);
    expect(stageStale(null, now)).toBe(false);
  });
});
