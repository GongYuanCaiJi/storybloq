import { describe, it, expect } from "vitest";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { formatStatus, formatFederatedStatus } from "../../../src/core/output-formatter.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import type { ActiveSessionSummary } from "../../../src/core/session-scan.js";
import type { FederationState } from "../../../src/federation/state.js";
import type { Config } from "../../../src/models/config.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleStatus", () => {
  it("returns formatted status for md", async () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns valid JSON for json format", async () => {
    const ctx = makeCtx({ format: "json" });
    const result = await handleStatus(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBe("test");
  });

  it("handles empty project", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.output).toContain("0/0");
  });

  it("defaults to OK exit code", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
    expect(result.exitCode).toBeUndefined();
  });
});

describe("formatStatus with active sessions (ISS-023)", () => {
  it("shows no Active Sessions section when no sessions exist", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("Active Sessions");
  });

  it("shows Active Sessions section with session details", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "abcdef1234567890",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-042",
      ticketTitle: "Build API endpoint",
    }];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("## Active Sessions");
    expect(output).toContain("abcdef12");
    expect(output).toContain("IMPLEMENT");
    expect(output).toContain("T-042");
    expect(output).toContain("auto mode");
  });

  it("excludes sessions from output when array is empty", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("## Active Sessions");
  });

  it("shows multiple active sessions", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [
      { sessionId: "sess-aaa", state: "PLAN", mode: "guided", ticketId: "T-001", ticketTitle: "First" },
      { sessionId: "sess-bbb", state: "CODE_REVIEW", mode: "review", ticketId: "T-002", ticketTitle: "Second" },
    ];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("sess-aaa");
    expect(output).toContain("sess-bbb");
    expect(output).toContain("guided mode");
    expect(output).toContain("review mode");
  });

  it("includes activeSessions in JSON output", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "sess-json",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-010",
      ticketTitle: "JSON test",
    }];
    const output = formatStatus(state, "json", sessions);
    const parsed = JSON.parse(output);
    expect(parsed.data.activeSessions).toHaveLength(1);
    expect(parsed.data.activeSessions[0].sessionId).toBe("sess-json");
  });

  it("omits activeSessions key from JSON when no sessions", () => {
    const state = makeState();
    const output = formatStatus(state, "json", []);
    const parsed = JSON.parse(output);
    expect(parsed.data.activeSessions).toBeUndefined();
  });
});

const orchestratorConfig: Config = {
  version: 2,
  schemaVersion: 2,
  project: "studio",
  type: "orchestrator",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  nodes: {
    engine: { path: "~/Dev/engine", health: "green", role: "Core engine", summary: "Pipeline working", dependsOn: [] },
    cloud: { path: "~/Dev/cloud", health: "yellow", role: "Cloud API", summary: "Webhook system", dependsOn: ["engine"] },
  },
};

const sampleFedState: FederationState = {
  orchestratorProject: "studio",
  nodeCount: 2,
  reachableCount: 2,
  unreachableCount: 0,
  nodes: [
    {
      name: "engine",
      rawPath: "~/Dev/engine",
      resolvedPath: "/Users/dev/engine",
      health: "green",
      role: "Core engine",
      summary: "Pipeline working",
      dependsOn: [],
      reachable: true,
      scanSummary: {
        project: "engine", type: "npm", ticketCount: 45, openTickets: 10,
        completeTickets: 35, issueCount: 5, openIssues: 3,
        lastHandoverDate: "2026-05-18", lastHandoverTitle: "Session",
      },
    },
    {
      name: "cloud",
      rawPath: "~/Dev/cloud",
      resolvedPath: "/Users/dev/cloud",
      health: "yellow",
      role: "Cloud API",
      summary: "Webhook system",
      dependsOn: ["engine"],
      reachable: true,
      scanSummary: {
        project: "cloud", type: "npm", ticketCount: 30, openTickets: 8,
        completeTickets: 22, issueCount: 3, openIssues: 2,
        lastHandoverDate: "2026-05-17", lastHandoverTitle: "Feature",
      },
    },
  ],
  totalTickets: 75,
  totalOpenTickets: 18,
  totalCompleteTickets: 57,
  totalIssues: 8,
  totalOpenIssues: 5,
  lastScanTimestamp: new Date().toISOString(),
};

describe("formatFederatedStatus (T-334)", () => {
  it("shows orchestrator heading with federation summary", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("studio");
    expect(output).toContain("orchestrator");
    expect(output).toContain("2 nodes");
  });

  it("shows node table with health and counts", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("engine");
    expect(output).toContain("green");
    expect(output).toContain("cloud");
    expect(output).toContain("yellow");
  });

  it("shows aggregated ticket/issue totals", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("75");
    expect(output).toContain("5 open");
  });

  it("shows unreachable nodes with reason", () => {
    const withUnreachable: FederationState = {
      ...sampleFedState,
      reachableCount: 1,
      unreachableCount: 1,
      nodes: [
        sampleFedState.nodes[0]!,
        {
          name: "cloud",
          rawPath: "~/Dev/cloud",
          resolvedPath: null,
          health: "yellow",
          role: "Cloud API",
          summary: "",
          dependsOn: ["engine"],
          reachable: false,
          unreachableReason: "path does not exist",
        },
      ],
    };
    const output = formatFederatedStatus(withUnreachable, orchestratorConfig, "md");
    expect(output).toContain("unreachable");
  });

  it("produces valid JSON output", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "json");
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.data.federation).toBeDefined();
    expect(parsed.data.federation.nodeCount).toBe(2);
    expect(parsed.data.federation.totalTickets).toBe(75);
  });

  it("includes review backends when configured", () => {
    const configWithReview: Config = {
      ...orchestratorConfig,
      recipeOverrides: { reviewBackends: ["lenses", "agent"] },
    };
    const output = formatFederatedStatus(sampleFedState, configWithReview, "md");
    expect(output).toContain("lenses");
  });
});
