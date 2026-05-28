import { z } from "zod";
import { NOTE_STATUSES, LIFECYCLE_VALUES, DateSchema, TimestampSchema, NoteIdSchema, ConflictEntrySchema } from "./types.js";

export const NoteSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().nullable(),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    tags: z.array(z.string()),
    status: z.enum(NOTE_STATUSES),
    createdDate: DateSchema,
    updatedDate: DateSchema,
    createdBy: z.string().nullable().optional(),
    updatedAt: TimestampSchema,
    displayId: z.string().optional(),
    previousDisplayIds: z.array(z.string()).optional(),
    lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
    rank: z.string().optional(),
    createdAt: z.string().optional(),
    deletedAt: z.string().optional(),
    deletedBy: z.string().optional(),
    _conflicts: z.array(ConflictEntrySchema).optional(),
  })
  .passthrough();

export type Note = z.infer<typeof NoteSchema>;
