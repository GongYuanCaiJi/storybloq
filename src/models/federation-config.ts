import { z } from "zod";

export const NODE_NAME_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

export const RESERVED_NODE_NAMES = [".story", "node_modules", ".git"];

export const NODE_HEALTH_VALUES = ["green", "yellow", "red", "grey"] as const;
export type NodeHealth = (typeof NODE_HEALTH_VALUES)[number];

export const NodeNameSchema = z
  .string()
  .regex(NODE_NAME_REGEX, "Node name must match ^[a-z][a-z0-9_-]{0,63}$")
  .refine((name) => !RESERVED_NODE_NAMES.includes(name), {
    message: "Node name is reserved",
  });

export const NodeHealthSchema = z.enum(NODE_HEALTH_VALUES);

export const PathSafetySchema = z
  .string()
  .min(1, "Path must not be empty")
  .refine((p) => !p.includes("\0"), { message: "Path must not contain null bytes" })
  .refine((p) => !p.replace(/\\/g, "/").split("/").includes(".."), {
    message: "Path must not contain .. segments",
  });

export const NodeSchema = z
  .object({
    path: PathSafetySchema,
    stack: z.string().max(40).optional().default(""),
    role: z.string().max(120).optional().default(""),
    summary: z.string().max(200).optional().default(""),
    health: NodeHealthSchema.optional().default("grey"),
    dependsOn: z.array(NodeNameSchema).optional().default([]),
  })
  .passthrough();

export type NodeConfig = z.infer<typeof NodeSchema>;

export const NodesMapSchema = z.record(NodeNameSchema, NodeSchema);

export type NodesMap = z.infer<typeof NodesMapSchema>;

export const FederationSettingsSchema = z
  .object({
    allowNodeWrites: z.boolean().optional().default(false),
  })
  .passthrough();

export type FederationSettings = z.infer<typeof FederationSettingsSchema>;

export interface OrchestratorOverlayResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

function detectCycles(
  nodes: Record<string, { dependsOn?: string[] }>,
): string | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const key of Object.keys(nodes)) {
    color.set(key, WHITE);
  }

  for (const start of Object.keys(nodes)) {
    if (color.get(start) !== WHITE) continue;

    const stack: string[] = [start];
    parent.set(start, null);

    while (stack.length > 0) {
      const u = stack[stack.length - 1]!;

      if (color.get(u) === WHITE) {
        color.set(u, GRAY);
        const deps = nodes[u]?.dependsOn ?? [];
        for (const v of deps) {
          if (!nodes[v]) continue;
          if (color.get(v) === GRAY) {
            const cycle: string[] = [v];
            let cur = u;
            while (cur !== v) {
              cycle.push(cur);
              cur = parent.get(cur)!;
            }
            cycle.push(v);
            cycle.reverse();
            return cycle.join(" -> ");
          }
          if (color.get(v) === WHITE) {
            parent.set(v, u);
            stack.push(v);
          }
        }
      } else {
        color.set(u, BLACK);
        stack.pop();
      }
    }
  }

  return null;
}

export function validateOrchestratorOverlay(
  config: Record<string, unknown>,
): OrchestratorOverlayResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (config.type !== "orchestrator") {
    return { valid: true, warnings, errors };
  }

  const rawNodes = config.nodes;
  if (
    !rawNodes ||
    typeof rawNodes !== "object" ||
    Array.isArray(rawNodes) ||
    Object.keys(rawNodes).length === 0
  ) {
    return { valid: true, warnings, errors };
  }

  const nodeEntries = rawNodes as Record<string, unknown>;
  const nodeKeys = new Set(Object.keys(nodeEntries));
  const nodesForCycle: Record<string, { dependsOn?: string[] }> = {};
  const paths = new Map<string, string>();

  for (const [key, value] of Object.entries(nodeEntries)) {
    const nameResult = NodeNameSchema.safeParse(key);
    if (!nameResult.success) {
      errors.push(
        `Invalid node name "${key}": ${nameResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const nodeResult = NodeSchema.safeParse(value);
    if (!nodeResult.success) {
      errors.push(
        `Node "${key}": ${nodeResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const node = value as Record<string, unknown>;
    const deps = Array.isArray(node.dependsOn) ? (node.dependsOn as string[]) : [];

    for (const dep of deps) {
      if (typeof dep === "string" && !nodeKeys.has(dep)) {
        errors.push(
          `Node "${key}": dependsOn references non-existent node "${dep}"`,
        );
      }
    }

    nodesForCycle[key] = { dependsOn: deps };

    if (typeof node.path === "string") {
      const existing = paths.get(node.path);
      if (existing) {
        warnings.push(
          `Duplicate path "${node.path}" shared by nodes "${existing}" and "${key}"`,
        );
      } else {
        paths.set(node.path, key);
      }
    }
  }

  const cycle = detectCycles(nodesForCycle);
  if (cycle) {
    errors.push(`Dependency cycle detected: ${cycle}`);
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
