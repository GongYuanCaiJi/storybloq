import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/models/config.js";
import { allocateDisplayId } from "../../src/core/remote-refs.js";
import { makeTicket, makeState, minimalConfig } from "../core/test-factories.js";

describe("config schema idAllocator", () => {
  it("accepts idAllocator: git-refs", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocator: local", () => {
    const config = { ...minimalConfig, team: { idAllocator: "local" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocatorRemote", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs", idAllocatorRemote: "upstream" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });
});

describe("allocateDisplayId", () => {
  it("with local mode returns local ID", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001" }), makeTicket({ id: "T-002" })],
      config: { ...minimalConfig, team: { idAllocator: "local" } },
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-003");
    expect(result.reserved).toBe(false);
  });

  it("with undefined allocator defaults to local", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-005" })],
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-006");
    expect(result.reserved).toBe(false);
  });

  it("returns correct next ID for issues", () => {
    const state = makeState({
      issues: [],
    });
    const result = allocateDisplayId("issue", state);
    expect(result.displayId).toBe("ISS-001");
  });

  it("returns correct next ID for notes", () => {
    const state = makeState({ notes: [] });
    const result = allocateDisplayId("note", state);
    expect(result.displayId).toBe("N-001");
  });

  it("returns correct next ID for lessons", () => {
    const state = makeState({ lessons: [] });
    const result = allocateDisplayId("lesson", state);
    expect(result.displayId).toBe("L-001");
  });
});
