import { z } from "zod";

export const FeaturesSchema = z
  .object({
    tickets: z.boolean(),
    issues: z.boolean(),
    handovers: z.boolean(),
    roadmap: z.boolean(),
    reviews: z.boolean(),
  })
  .passthrough();

export type Features = z.infer<typeof FeaturesSchema>;

export const ConfigSchema = z
  .object({
    version: z.number().int().min(1),
    schemaVersion: z.number().int().optional(),
    project: z.string().min(1),
    type: z.string(),
    language: z.string(),
    features: FeaturesSchema,
    recipe: z.string().optional(),  // default "coding" applied in guide.ts handleStart
    recipeOverrides: z.object({
      maxTicketsPerSession: z.number().min(0).optional(),
      compactThreshold: z.string().optional(),
      reviewBackends: z.array(z.string()).optional(),
      codexReviewBackends: z.array(z.string()).optional(),
      handoverInterval: z.number().min(0).optional(),
      stages: z.record(z.record(z.unknown())).optional(),
      branchStrategy: z.enum(["none", "per-ticket"]).optional(),
      maxParallelAgents: z.number().min(1).max(8).optional(),
    }).optional(),
    nodes: z.record(z.string(), z.unknown()).optional(),
    orchestrator: z.string().optional(),
    federation: z.record(z.unknown()).optional(),
    team: z.object({
      enabled: z.boolean().optional(),
      minCliVersion: z.string().optional(),
      minMacVersion: z.string().optional(),
      requiredFeatures: z.array(z.string()).optional(),
      claimStalenessHours: z.number().finite().nonnegative().optional(),
      idAllocator: z.enum(["local", "git-refs"]).optional(),
      idAllocatorRemote: z.string().regex(/^[A-Za-z0-9._-]+$/).refine((v) => !v.startsWith("-"), "Remote name must not start with -").optional(),
      mergeDriverVersion: z.number().int().optional(),
    }).optional(),
  })
  .passthrough();

export type Config = z.infer<typeof ConfigSchema>;
