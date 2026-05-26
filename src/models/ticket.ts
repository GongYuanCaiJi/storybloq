import { z } from "zod";
import {
  TICKET_STATUSES,
  TICKET_TYPES,
  LIFECYCLE_VALUES,
  DateSchema,
  TicketIdSchema,
  ConflictEntrySchema,
  ClaimSchema,
} from "./types.js";

export const CROSS_NODE_REF_REGEX = /^[a-z][a-z0-9_-]{0,63}:(T-\d+[a-z]?|ISS-\d+)$/;
export const CROSS_NODE_REF_CAPTURE_REGEX = /^([a-z][a-z0-9_-]{0,63}):(T-\d+[a-z]?|ISS-\d+)$/;

export const TicketSchema = z
  .object({
    id: TicketIdSchema,
    title: z.string().min(1),
    description: z.string(),
    type: z.enum(TICKET_TYPES),
    status: z.enum(TICKET_STATUSES),
    phase: z.string().nullable(),
    order: z.number().int(),
    createdDate: DateSchema,
    completedDate: DateSchema.nullable(),
    blockedBy: z.array(TicketIdSchema),
    parentTicket: TicketIdSchema.nullable().optional(),
    // Attribution fields — unused in v1, baked in to avoid future migration
    createdBy: z.string().nullable().optional(),
    assignedTo: z.string().nullable().optional(),
    lastModifiedBy: z.string().nullable().optional(),
    // ISS-027: Autonomous session ownership — set when ticket claimed as inprogress
    claimedBySession: z.string().nullable().optional(),
    crossNodeBlockedBy: z.array(z.string().regex(CROSS_NODE_REF_REGEX, "Cross-node ref must match node:ID format")).optional(),
    displayId: z.string().optional(),
    previousDisplayIds: z.array(z.string()).optional(),
    lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
    rank: z.string().optional(),
    createdAt: z.string().optional(),
    deletedAt: z.string().optional(),
    deletedBy: z.string().optional(),
    _conflicts: z.array(ConflictEntrySchema).optional(),
    claim: ClaimSchema.optional(),
  })
  .passthrough();

export type Ticket = z.infer<typeof TicketSchema>;
