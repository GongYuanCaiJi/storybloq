import { z } from "zod";
import { LESSON_STATUSES, LESSON_SOURCES, LIFECYCLE_VALUES, DateSchema, TimestampSchema, LessonIdSchema, ConflictEntrySchema } from "./types.js";

export const LessonSchema = z
  .object({
    id: LessonIdSchema,
    title: z.string().min(1, "Title cannot be empty"),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    context: z.string(),
    source: z.enum(LESSON_SOURCES),
    tags: z.array(z.string()),
    reinforcements: z.number().int().min(0),
    lastValidated: DateSchema,
    createdDate: DateSchema,
    updatedDate: DateSchema,
    createdBy: z.string().nullable().optional(),
    updatedAt: TimestampSchema,
    supersedes: LessonIdSchema.nullable(),
    status: z.enum(LESSON_STATUSES),
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

export type Lesson = z.infer<typeof LessonSchema>;
