import { z } from "zod";
import { DateSchema, TimestampSchema, RulingIdSchema, OwnerTaskLikeSchema } from "./types.js";

/**
 * T-476's exact three attribution values. `attribution` is a CLAIM asserted
 * by the recorder, never verified by storybloq -- see `recordedBy` below and
 * the anti-laundering caveat in `src/core/ruling.ts`'s module docblock.
 */
export const RULING_ATTRIBUTIONS = [
  "owner-direct",
  "owner-via-manager-with-owner-veto",
  "manager-delegated",
] as const;
export type RulingAttribution = (typeof RULING_ATTRIBUTIONS)[number];

/** T-522: stored status values. Absent means a 1.15 record: accepted by shape. */
export const RULING_STATUSES = ["proposed", "accepted", "withdrawn"] as const;

/**
 * T-522: WHO accepted, and a digest of WHAT was accepted. The digest is the
 * proof that the payload is the one the acceptor saw (`payloadDigest` in
 * `src/core/ruling-lifecycle.ts`); `attribution`/`recordedBy` are a CLAIM of
 * who ruled, exactly as on the record itself.
 */
export const RulingAcceptanceSchema = z
  .object({
    attribution: z.enum(RULING_ATTRIBUTIONS),
    recordedBy: OwnerTaskLikeSchema,
    date: DateSchema,
    createdAt: TimestampSchema,
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/, "payloadDigest must be a hex sha256"),
  })
  .passthrough();

export const RulingWithdrawalSchema = z
  .object({
    recordedBy: OwnerTaskLikeSchema,
    createdAt: TimestampSchema,
    reason: z.string().optional(),
  })
  .passthrough();

/** Free-text rationale around a ruling. Never part of the digest: it is commentary, not the decision. */
export const RulingNarrativeSchema = z
  .object({
    context: z.string().optional(),
    alternatives: z.string().optional(),
    consequences: z.string().optional(),
    reconsiderWhen: z.string().optional(),
  })
  .passthrough();

/**
 * A verbatim, attributed decision record with a supersedes-chain.
 *
 * `text` carries NO transform/trim -- verbatim means byte-verbatim, per the
 * ticket's own pitfall list: no markdown cleanup, no em-dash-policy edits
 * inside quoted text. `recordedBy` is WHO WROTE THIS RECORD (session/task
 * identity), independent of and never a substitute for `attribution` (the
 * claimed source of the ruling) -- this is what turns the two-key rule from
 * etiquette into checkable provenance without replacing the second key.
 *
 * `.passthrough()` matches every other T-47x model (`LessonSchema`,
 * `ArrangementSchema`): forward-compatible unknown fields survive a
 * parse/rewrite round trip.
 */
export const RulingSchema = z
  .object({
    id: RulingIdSchema,
    text: z.string().min(1, "Ruling text cannot be empty"),
    attribution: z.enum(RULING_ATTRIBUTIONS),
    recordedBy: OwnerTaskLikeSchema,
    date: DateSchema,
    scopeTags: z.array(z.string()).default([]),
    supersedes: RulingIdSchema.nullable(),
    createdAt: TimestampSchema,
    // T-522: the proposal lifecycle. Every field is OPTIONAL so a 1.15 record
    // (none of them present) parses byte-identically and classifies as
    // `accepted-legacy` -- no default is injected, because a default would
    // fabricate acceptance evidence for a record that never carried any.
    status: z.enum(RULING_STATUSES).optional(),
    /**
     * The edge a proposal ASKS for. Only `accept` copies it into
     * `supersedes`; a proposal's own `supersedes` must stay null, since the
     * 1.15 index reads `supersedes` unconditionally and would let a
     * hand-written proposal displace the ruling it merely proposes to
     * replace.
     */
    proposesToSupersede: RulingIdSchema.nullable().optional(),
    proposedFor: z.array(z.string()).optional(),
    narrative: RulingNarrativeSchema.optional(),
    acceptance: RulingAcceptanceSchema.optional(),
    withdrawal: RulingWithdrawalSchema.optional(),
  })
  .passthrough();

export type RulingStatus = (typeof RULING_STATUSES)[number];
export type RulingAcceptance = z.infer<typeof RulingAcceptanceSchema>;

export type Ruling = z.infer<typeof RulingSchema>;
