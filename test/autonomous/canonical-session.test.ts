import { describe, it, expect } from "vitest";
import { TARGET_WORK_ID_REGEX } from "../../src/autonomous/session-types.js";
import { resolveWorkId } from "../../src/autonomous/id-resolution.js";
import { makeTicket, makeIssue, makeState } from "../core/test-factories.js";

describe("TARGET_WORK_ID_REGEX", () => {
  it("accepts canonical ticket ID", () => {
    expect(TARGET_WORK_ID_REGEX.test("t-0123456789abcdef")).toBe(true);
  });

  it("accepts canonical issue ID", () => {
    expect(TARGET_WORK_ID_REGEX.test("i-0123456789abcdef")).toBe(true);
  });

  it("still accepts sequential IDs", () => {
    expect(TARGET_WORK_ID_REGEX.test("T-001")).toBe(true);
    expect(TARGET_WORK_ID_REGEX.test("T-042a")).toBe(true);
    expect(TARGET_WORK_ID_REGEX.test("ISS-001")).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(TARGET_WORK_ID_REGEX.test("N-001")).toBe(false);
    expect(TARGET_WORK_ID_REGEX.test("L-001")).toBe(false);
    expect(TARGET_WORK_ID_REGEX.test("t-short")).toBe(false);
    expect(TARGET_WORK_ID_REGEX.test("random")).toBe(false);
  });
});

describe("resolveWorkId", () => {
  it("returns canonical + display for sequential input", () => {
    const ticket = makeTicket({ id: "t-0123456789abcdef", displayId: "T-001" });
    const state = makeState({ tickets: [ticket] });
    const result = resolveWorkId("T-001", state);
    expect(result.canonicalId).toBe("t-0123456789abcdef");
    expect(result.displayId).toBe("T-001");
  });

  it("returns canonical + display for canonical input", () => {
    const ticket = makeTicket({ id: "t-0123456789abcdef", displayId: "T-001" });
    const state = makeState({ tickets: [ticket] });
    const result = resolveWorkId("t-0123456789abcdef", state);
    expect(result.canonicalId).toBe("t-0123456789abcdef");
    expect(result.displayId).toBe("T-001");
  });

  it("falls back on missing item", () => {
    const state = makeState({});
    const result = resolveWorkId("T-999", state);
    expect(result.canonicalId).toBe("T-999");
    expect(result.displayId).toBe("T-999");
  });
});
