/**
 * T-527 (plan 3.1): routing into KNOWLEDGE_REVIEW.
 *
 * FINALIZE records the review an item owes in the same write that records the
 * commit (`knowledgeReview`, status `pending`). From then on the item is not
 * complete until that review is accepted, so every successful FINALIZE exit,
 * and COMPLETE's own entry, goes to KNOWLEDGE_REVIEW while one is pending and
 * keeps its original exit otherwise. COMPLETE is checked as well as FINALIZE
 * because it is the stage that clears the item's attempt and implementer, and
 * a pending review must never be carried past that write.
 */
import type { FullSessionState } from "../session-types.js";
import { attemptMatchesSubject } from "../review-identity.js";
import type { StageAdvance, StageContext } from "./types.js";

export type KnowledgeReviewRecord = NonNullable<FullSessionState["knowledgeReview"]>;

export function knowledgeReviewPending(state: FullSessionState): boolean {
  return state.knowledgeReview?.status === "pending";
}

/** A FINALIZE exit, redirected while a knowledge review is pending. */
export function routeAfterFinalize(ctx: StageContext, original: StageAdvance): StageAdvance {
  return knowledgeReviewPending(ctx.state) ? { action: "goto", target: "KNOWLEDGE_REVIEW" } : original;
}

/**
 * The attempt id a review is stored under when the session has no attempt for
 * this item: a session resumed from before attempts existed can still reach
 * FINALIZE, and the storage key must still be stable across a replay (D1).
 */
export function legacyAttemptId(itemId: string, implementationCommit: string): string {
  return `legacy:${itemId}:${implementationCommit.slice(0, 8)}`;
}

/** The pending record FINALIZE writes beside `finalizedItem`. */
export function pendingKnowledgeReview(
  state: FullSessionState,
  item: { readonly kind: "ticket" | "issue"; readonly id: string },
  implementationCommit: string,
): KnowledgeReviewRecord {
  const attempt = state.itemAttempt;
  const itemAttemptId = attemptMatchesSubject(attempt, { workItemId: item.id, kind: item.kind })
    ? attempt!.id
    : legacyAttemptId(item.id, implementationCommit);
  return {
    itemId: item.id,
    kind: item.kind,
    itemAttemptId,
    implementationCommit,
    checkpoint: implementationCommit,
    status: "pending",
  };
}
