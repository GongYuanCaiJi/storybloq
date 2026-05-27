import type { Claim } from "../models/types.js";
import type { Ticket } from "../models/ticket.js";
import type { Recommendation } from "./recommend.js";

export interface CanClaimResult {
  allowed: boolean;
  claimedBy?: string;
}

export function buildClaim(user: string, branch: string, since: string): Claim {
  return { user, branch, since };
}

export function canClaim(
  ticket: Ticket,
  user: string,
  branch: string,
  force?: boolean,
): CanClaimResult {
  if (!ticket.claim) {
    return { allowed: true };
  }
  if (ticket.claim.user === user && ticket.claim.branch === branch) {
    return { allowed: true };
  }
  if (force) {
    return { allowed: true };
  }
  return { allowed: false, claimedBy: ticket.claim.user };
}

export function isClaimStale(
  claim: Claim,
  thresholdHours: number,
  nowMs?: number,
): boolean {
  const since = Date.parse(claim.since);
  if (isNaN(since)) return true;
  const now = nowMs ?? Date.now();
  const ageHours = (now - since) / (1000 * 60 * 60);
  return ageHours > thresholdHours;
}

export function clearClaimOnComplete(ticket: Ticket): Ticket {
  if (ticket.status === "complete" && ticket.claim) {
    const { claim: _, ...rest } = ticket;
    return rest as Ticket;
  }
  return ticket;
}

export function filterClaimedFromRecommendations(
  recommendations: readonly Recommendation[],
  claims: ReadonlyMap<string, Claim>,
  currentUser: string | null,
): Recommendation[] {
  if (claims.size === 0) {
    return [...recommendations];
  }
  return recommendations.filter((rec) => {
    const claim = claims.get(rec.id);
    if (!claim) return true;
    if (currentUser === null) return false;
    return claim.user === currentUser;
  });
}
