import { describe, it, expect } from "vitest";
import { canClaim, buildClaim } from "../../src/core/claims.js";
import { gitUserEmail } from "../../src/autonomous/git-inspector.js";
import { makeTicket } from "../core/test-factories.js";
import type { Ticket } from "../../src/models/ticket.js";

describe("autonomous claim integration", () => {
  describe("gitUserEmail", () => {
    it("returns a string email from git config", async () => {
      const email = await gitUserEmail(".");
      expect(typeof email).toBe("string");
      expect(email).not.toBe("");
    });
  });

  describe("claim check at pick-ticket time", () => {
    it("allows claim on unclaimed ticket", () => {
      const ticket = makeTicket({ id: "T-001" }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(true);
    });

    it("rejects claim on ticket claimed by another user", () => {
      const ticket = makeTicket({
        id: "T-001",
        claim: { user: "human@example.com", branch: "feature/manual", since: "2026-05-26T00:00:00Z" },
      }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(false);
      expect(result.claimedBy).toBe("human@example.com");
    });

    it("allows re-claim by same identity", () => {
      const ticket = makeTicket({
        id: "T-001",
        claim: { user: "agent@ci.local", branch: "feature/auto", since: "2026-05-26T00:00:00Z" },
      }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(true);
    });

    it("buildClaim creates valid claim for autonomous use", () => {
      const claim = buildClaim("agent@ci.local", "feature/auto", "2026-05-26T12:00:00Z");
      expect(claim.user).toBe("agent@ci.local");
      expect(claim.branch).toBe("feature/auto");
      expect(claim.since).toBe("2026-05-26T12:00:00Z");
    });
  });
});
