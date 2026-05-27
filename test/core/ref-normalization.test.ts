import { describe, it, expect } from "vitest";
import {
  resolveAndNormalizeTicketRef,
  resolveAndNormalizeTicketRefs,
} from "../../src/core/ref-normalization.js";
import { ProjectState } from "../../src/core/project-state.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { Config } from "../../src/models/config.js";
import type { Roadmap } from "../../src/models/roadmap.js";

function stubTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: overrides.id,
    title: "test",
    type: "task",
    status: "open",
    phase: "p0",
    order: 10,
    description: "",
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
    ...overrides,
  } as Ticket;
}

function makeState(tickets: Ticket[]): ProjectState {
  const config: Config = {
    version: 2,
    project: "test",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: false },
  } as Config;
  const roadmap: Roadmap = {
    title: "test",
    date: "2026-01-01",
    phases: [{ id: "p0", label: "P0", name: "Test", description: "test" }],
    blockers: [],
  } as Roadmap;
  return new ProjectState({
    tickets,
    issues: [],
    notes: [],
    lessons: [],
    roadmap,
    config,
    handoverFilenames: [],
  });
}

describe("resolveAndNormalizeTicketRef", () => {
  it("resolves legacy ref to legacy primary id", () => {
    const state = makeState([stubTicket({ id: "T-001" })]);
    expect(resolveAndNormalizeTicketRef(state, "T-001")).toBe("T-001");
  });

  it("resolves canonical ref to canonical primary id", () => {
    const state = makeState([
      stubTicket({ id: "t-k7m2p9x3w4a5b6e8", displayId: "T-001" }),
    ]);
    expect(resolveAndNormalizeTicketRef(state, "t-k7m2p9x3w4a5b6e8")).toBe("t-k7m2p9x3w4a5b6e8");
  });

  it("resolves displayId ref to primary id", () => {
    const state = makeState([
      stubTicket({ id: "t-k7m2p9x3w4a5b6e8", displayId: "T-001" }),
    ]);
    expect(resolveAndNormalizeTicketRef(state, "T-001")).toBe("t-k7m2p9x3w4a5b6e8");
  });

  it("resolves previousDisplayId ref to current primary id", () => {
    const state = makeState([
      stubTicket({
        id: "t-k7m2p9x3w4a5b6e8",
        displayId: "T-005",
        previousDisplayIds: ["T-001"],
      }),
    ]);
    expect(resolveAndNormalizeTicketRef(state, "T-001")).toBe("t-k7m2p9x3w4a5b6e8");
  });

  it("throws on missing ref", () => {
    const state = makeState([]);
    expect(() => resolveAndNormalizeTicketRef(state, "T-999")).toThrow(/not found/i);
  });

  it("throws on ambiguous ref with match details", () => {
    const state = makeState([
      stubTicket({ id: "t-aaa1234567890aaa", displayId: "T-001" }),
      stubTicket({ id: "t-bbb1234567890bbb", displayId: "T-001" }),
    ]);
    expect(() => resolveAndNormalizeTicketRef(state, "T-001")).toThrow(/ambiguous/i);
  });
});

describe("resolveAndNormalizeTicketRefs (batch)", () => {
  it("resolves array of refs", () => {
    const state = makeState([
      stubTicket({ id: "T-001" }),
      stubTicket({ id: "T-002" }),
    ]);
    expect(resolveAndNormalizeTicketRefs(state, ["T-001", "T-002"])).toEqual([
      "T-001",
      "T-002",
    ]);
  });

  it("fails atomically on any invalid ref", () => {
    const state = makeState([stubTicket({ id: "T-001" })]);
    expect(() =>
      resolveAndNormalizeTicketRefs(state, ["T-001", "T-999"]),
    ).toThrow(/not found/i);
  });

  it("returns empty array for empty input", () => {
    const state = makeState([]);
    expect(resolveAndNormalizeTicketRefs(state, [])).toEqual([]);
  });
});
