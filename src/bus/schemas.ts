import { z } from "zod";
import { CLIENT_TASK_ID_PATTERN } from "../autonomous/client-profile.js";

export const BUS_SCHEMA_VERSION = 2 as const;
export const DEFAULT_BUS_MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_BUS_MAX_HOPS = 8;
export const BUS_MAX_ENTRY_BYTES = 32 * 1024;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const OpaqueStringSchema = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value),
  "Control characters are not allowed",
);
const GitObjectSchema = z.string().regex(/^[a-f0-9]{4,64}$/i);

// BusRole survives only as a derived display concept and for reading archived v1
// records. v2 messages are endpoint-addressed; role is never declared or enforced.
export const BusRoleSchema = z.enum(["implementer", "reviewer"]);
export type BusRole = z.infer<typeof BusRoleSchema>;

export const BusClientSchema = z.enum(["claude", "codex"]);
export type BusClient = z.infer<typeof BusClientSchema>;

export const BusSurfaceSchema = z.enum(["claude_cli", "codex_cli", "codex_desktop"]);
export type BusSurface = z.infer<typeof BusSurfaceSchema>;

export const BusThreadKindSchema = z.enum([
  "issue_notice",
  "question",
  "coordination",
  "patch_request",
]);
export type BusThreadKind = z.infer<typeof BusThreadKindSchema>;

export const BusMessageKindSchema = z.enum([
  "issue_notice",
  "question",
  "reply",
  "status",
  "patch_request",
  "claim",
  "release",
]);
export type BusMessageKind = z.infer<typeof BusMessageKindSchema>;

export const BusSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type BusSeverity = z.infer<typeof BusSeveritySchema>;

/**
 * Derived role rule (single source of truth). issue_notice/patch_request imply
 * the sender acted as reviewer; claim/release imply implementer; question/reply/
 * status are unlabeled (null). Used only for display/export/poll envelopes. No
 * enforcement: any endpoint may send any kind (that is the fluidity).
 */
export function derivedRole(kind: BusMessageKind): BusRole | null {
  if (kind === "issue_notice" || kind === "patch_request") return "reviewer";
  if (kind === "claim" || kind === "release") return "implementer";
  return null;
}

export const BusTopicRefSchema = z.object({
  issue: OpaqueStringSchema.optional(),
  ticket: OpaqueStringSchema.optional(),
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
}).passthrough().refine(
  (value) => value.issue !== undefined || value.ticket !== undefined ||
    value.commit !== undefined || value.ciRun !== undefined,
  "At least one topic reference is required",
);
export type BusTopicRef = z.infer<typeof BusTopicRefSchema>;

export const BusEvidenceRefSchema = z.object({
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
}).passthrough().refine(
  (value) => value.commit !== undefined || value.ciRun !== undefined,
  "A commit or CI run reference is required",
);
export type BusEvidenceRef = z.infer<typeof BusEvidenceRefSchema>;

export const BusThreadRecordSchema = z.object({
  schema: z.literal("storybloq-bus-thread/v2"),
  threadId: UuidSchema,
  kind: BusThreadKindSchema,
  topicRef: BusTopicRefSchema,
  participants: z.tuple([UuidSchema, UuidSchema]).refine(
    ([first, second]) => first !== second,
    "Thread participants must be two distinct endpoints",
  ),
  maxHops: z.number().int().min(2).max(32),
  createdByEndpoint: UuidSchema,
  createdAt: IsoTimestampSchema,
  predecessorThreadId: UuidSchema.optional(),
  threadHash: Sha256Schema,
}).passthrough();
export type BusThreadRecord = z.infer<typeof BusThreadRecordSchema>;

export const BusMessageRefsSchema = z.object({
  issue: OpaqueStringSchema.optional(),
  ticket: OpaqueStringSchema.optional(),
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
  files: z.array(z.string().min(1).max(1024)).max(64).optional(),
}).passthrough();
export type BusMessageRefs = z.infer<typeof BusMessageRefsSchema>;

export const BusMessagePayloadSchema = z.object({
  messageId: UuidSchema,
  from: z.object({
    endpointId: UuidSchema,
    client: BusClientSchema,
    authority: z.literal("peer_agent"),
  }).passthrough(),
  to: UuidSchema,
  kind: BusMessageKindSchema,
  severity: BusSeveritySchema,
  body: z.string().min(1).max(65536),
  refs: BusMessageRefsSchema,
  inReplyTo: UuidSchema.nullable(),
  idempotencyKeyHash: Sha256Schema,
  payloadHash: Sha256Schema,
}).passthrough();
export type BusMessagePayload = z.infer<typeof BusMessagePayloadSchema>;

export const BusAckPayloadSchema = z.object({
  messageId: UuidSchema,
  byEndpoint: UuidSchema,
  disposition: z.enum(["accepted", "rejected", "deferred"]),
  reason: z.string().min(1).max(4096).optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.disposition === "rejected" || value.disposition === "deferred") && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A reason is required" });
  }
});
export type BusAckPayload = z.infer<typeof BusAckPayloadSchema>;

export const BusStatePayloadSchema = z.object({
  action: z.enum(["park", "resolve", "reopen"]),
  byEndpoint: UuidSchema,
  reason: z.string().min(1).max(4096).optional(),
  resolution: z.string().min(1).max(8192).optional(),
  evidence: BusEvidenceRefSchema.optional(),
  automatic: z.boolean().optional(),
  trigger: z.enum(["hop_cap", "duplicate_fingerprint"]).optional(),
  // For an AUTOMATIC park ONLY: bind the park state entry to the exact idempotent send
  // operation that triggered it. entryHash covers the payload, so these are tamper-
  // evident; committedAutomaticPark requires both to match the replaying receipt, so a
  // tampered receipt whose stateEntryHash names a DIFFERENT same-endpoint automatic park
  // is rejected rather than misattributed. Absent on manual park/resolve/reopen.
  idempotencyKeyHash: Sha256Schema.optional(),
  payloadHash: Sha256Schema.optional(),
}).passthrough();
export type BusStatePayload = z.infer<typeof BusStatePayloadSchema>;

export const BusWakePayloadSchema = z.object({
  wakeId: UuidSchema,
  endpointId: UuidSchema,
  attempt: z.number().int().min(1).max(3),
  batchCursor: z.number().int().nonnegative(),
  action: z.enum(["requested", "poll_observed", "failed"]),
  reason: z.string().min(1).max(1024).optional(),
}).passthrough();
export type BusWakePayload = z.infer<typeof BusWakePayloadSchema>;

const BusEntryBaseSchema = z.object({
  schema: z.literal("storybloq-bus-entry/v2"),
  entryId: UuidSchema,
  threadId: UuidSchema,
  seq: z.number().int().positive(),
  prevHash: Sha256Schema,
  createdAt: IsoTimestampSchema,
  entryHash: Sha256Schema,
});

export const BusEntrySchema = z.discriminatedUnion("type", [
  BusEntryBaseSchema.extend({ type: z.literal("message"), payload: BusMessagePayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("ack"), payload: BusAckPayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("state"), payload: BusStatePayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("wake"), payload: BusWakePayloadSchema }).passthrough(),
]);
export type BusEntry = z.infer<typeof BusEntrySchema>;

export const BusMailboxPointerSchema = z.object({
  schema: z.literal("storybloq-bus-mailbox/v2"),
  endpointId: UuidSchema,
  mailboxSeq: z.number().int().positive(),
  messageId: UuidSchema,
  threadId: UuidSchema,
  entrySeq: z.number().int().positive(),
  entryHash: Sha256Schema,
  createdAt: IsoTimestampSchema,
}).passthrough();
export type BusMailboxPointer = z.infer<typeof BusMailboxPointerSchema>;

export const BusMailboxCounterSchema = z.object({
  schema: z.literal("storybloq-bus-mailbox-counter/v1"),
  nextSeq: z.number().int().positive(),
  updatedAt: IsoTimestampSchema,
}).passthrough();
export type BusMailboxCounter = z.infer<typeof BusMailboxCounterSchema>;

export const BusProcessRefSchema = z.object({
  pid: z.number().int().positive(),
  signature: z.string().min(1).max(512),
  capturedAt: IsoTimestampSchema,
}).passthrough();
export type BusProcessRef = z.infer<typeof BusProcessRefSchema>;

export const BusEndpointSchema = z.object({
  schema: z.literal("storybloq-bus-endpoint/v2"),
  endpointId: UuidSchema,
  client: BusClientSchema,
  surface: BusSurfaceSchema,
  clientTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  resumeHandle: OpaqueStringSchema.nullable(),
  projectRoot: z.string().min(1).max(4096),
  gitBranch: z.string().min(1).max(1024).nullable(),
  worktreeId: Sha256Schema,
  processRef: BusProcessRefSchema.nullable(),
  state: z.enum(["attached", "offline", "unknown"]),
  joinedAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
  wakePolicy: z.enum(["never", "offline_only"]),
  lastPolledMailboxSeq: z.number().int().nonnegative(),
  lastBlockedMailboxSeq: z.number().int().nonnegative(),
  retiredAt: IsoTimestampSchema.nullable(),
  retiredReason: z.string().min(1).max(1024).nullable(),
}).passthrough();
export type BusEndpoint = z.infer<typeof BusEndpointSchema>;

export const BusSuccessionSchema = z.object({
  schema: z.literal("storybloq-bus-succession/v1"),
  successionId: UuidSchema,
  endpointId: UuidSchema,
  client: BusClientSchema,
  fromTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  toTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN).optional(),
  transcriptHash: Sha256Schema,
  kind: z.enum(["compact", "wake"]),
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  consumedAt: IsoTimestampSchema.nullable(),
}).passthrough();
export type BusSuccession = z.infer<typeof BusSuccessionSchema>;

export interface FoldedBusThread {
  readonly thread: BusThreadRecord;
  readonly entries: readonly BusEntry[];
  readonly validThroughSeq: number;
  readonly lastHash: string;
  readonly state: "open" | "parked" | "resolved";
  readonly hopCount: number;
  readonly acknowledgments: ReadonlyMap<string, BusAckPayload>;
  readonly messages: readonly BusMessagePayload[];
  readonly seenEvidence: ReadonlySet<string>;
  readonly integrity: "verified" | "quarantined";
  readonly finding?: string;
}

export type BusSetupState =
  | "disabled"
  | "not_initialized"
  | "invalid"
  | "disconnected"
  | "waiting_for_peer"
  | "ready";

export type BusDeliveryMode = "live" | "partial" | "poll";

export interface BusParticipantSummary {
  readonly client: BusClient;
  readonly surface: BusSurface;
  readonly state: "attached" | "offline" | "unknown";
}

export interface BusSummary {
  readonly enabled: boolean;
  readonly initialized: boolean;
  readonly daemonState: "stopped";
  readonly setupState: BusSetupState;
  readonly deliveryMode: BusDeliveryMode;
  readonly participants: readonly BusParticipantSummary[];
  readonly nextActions: readonly string[];
  readonly endpoints: number;
  readonly pendingMessages: number;
  readonly unacknowledgedCritical: number;
  readonly openThreads: number;
  readonly parkedThreads: number;
  readonly undeliverable: number;
  readonly quarantined: number;
  readonly hookDelivery: {
    readonly claude: boolean;
    readonly codex: boolean;
  };
}
