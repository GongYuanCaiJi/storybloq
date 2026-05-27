import { describe, it, expect } from "vitest";
import {
  buildClaim,
  canClaim,
  isClaimStale,
  clearClaimOnComplete,
  filterClaimedFromRecommendations,
} from "../../src/core/claims.js";
import type { Claim } from "../../src/models/types.js";
import type { Ticket } from "../../src/models/ticket.js";
import { makeTicket, makeState, makeRoadmap, makePhase } from "./test-factories.js";

const now = "2026-05-26T12:00:00.000Z";

describe("buildClaim", () => {
  it("creates claim with user, branch, and timestamp", () => {
    const claim = buildClaim("alice@example.com", "feature/foo", now);
    expect(claim.user).toBe("alice@example.com");
    expect(claim.branch).toBe("feature/foo");
    expect(claim.since).toBe(now);
  });
});

describe("canClaim", () => {
  it("allows claim on unclaimed ticket", () => {
    const ticket = makeTicket({ id: "T-001" }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("allows re-claim by same user on same branch", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("rejects claim when claimed by another user without force", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(false);
    expect(result.claimedBy).toBe("bob@example.com");
  });

  it("allows claim when forced even if claimed by another", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo", true);
    expect(result.allowed).toBe(true);
  });
});

describe("isClaimStale", () => {
  it("returns false for fresh claim within threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 1 * 60 * 60 * 1000; // 1 hour later
    expect(isClaimStale(claim, 48, checkTime)).toBe(false);
  });

  it("returns true for claim older than threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 49 * 60 * 60 * 1000; // 49 hours later
    expect(isClaimStale(claim, 48, checkTime)).toBe(true);
  });
});

describe("clearClaimOnComplete", () => {
  it("clears claim when ticket status becomes complete", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = clearClaimOnComplete(ticket);
    expect(result.claim).toBeUndefined();
  });

  it("preserves claim when ticket is not complete", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "inprogress",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = clearClaimOnComplete(ticket);
    expect(result.claim).toBeDefined();
  });
});

describe("filterClaimedFromRecommendations", () => {
  it("excludes tickets claimed by others from recommendations", () => {
    const recs = [
      { id: "T-001", kind: "ticket" as const, title: "A", category: "open_ticket" as const, reason: "ready", score: 100 },
      { id: "T-002", kind: "ticket" as const, title: "B", category: "open_ticket" as const, reason: "ready", score: 90 },
    ];
    const claims = new Map<string, Claim>([
      ["T-002", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const filtered = filterClaimedFromRecommendations(recs, claims, "alice@example.com");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe("T-001");
  });

  it("keeps tickets claimed by current user", () => {
    const recs = [
      { id: "T-001", kind: "ticket" as const, title: "A", category: "open_ticket" as const, reason: "ready", score: 100 },
    ];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "alice@example.com", branch: "feature/foo", since: now }],
    ]);
    const filtered = filterClaimedFromRecommendations(recs, claims, "alice@example.com");
    expect(filtered).toHaveLength(1);
  });

  it("keeps all recommendations when no claims exist", () => {
    const recs = [
      { id: "T-001", kind: "ticket" as const, title: "A", category: "open_ticket" as const, reason: "ready", score: 100 },
    ];
    const filtered = filterClaimedFromRecommendations(recs, new Map(), "alice@example.com");
    expect(filtered).toHaveLength(1);
  });

  it("keeps all when currentUser is null (identity unavailable)", () => {
    const recs = [
      { id: "T-001", kind: "ticket" as const, title: "A", category: "open_ticket" as const, reason: "ready", score: 100 },
    ];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const filtered = filterClaimedFromRecommendations(recs, claims, null);
    expect(filtered).toHaveLength(0);
  });
});
