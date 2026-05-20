import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodePath } from "../federation/resolver.js";
import { NodesMapSchema } from "../models/federation-config.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type NodeResolutionResult =
  | { ok: true; root: string }
  | { ok: false; error: string; errorCode: string };

export function readOrchestratorConfig(pinnedRoot: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(pinnedRoot, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveNodeRoot(
  pinnedRoot: string,
  nodeName: string,
  config?: Record<string, unknown>,
): NodeResolutionResult {
  if (!config) {
    config = readOrchestratorConfig(pinnedRoot) ?? undefined;
    if (!config) {
      return { ok: false, error: "Cannot read orchestrator config", errorCode: "io_error" };
    }
  }

  if (config.type !== "orchestrator") {
    return {
      ok: false,
      error: "Node parameter is only supported on orchestrator projects.",
      errorCode: "not_orchestrator",
    };
  }

  const rawNodes = config.nodes;
  if (!rawNodes || typeof rawNodes !== "object" || Array.isArray(rawNodes)) {
    return { ok: false, error: `Node "${nodeName}" not found in orchestrator config.`, errorCode: "node_not_found" };
  }

  const nodeEntries = rawNodes as Record<string, unknown>;
  if (!(nodeName in nodeEntries)) {
    return { ok: false, error: `Node "${nodeName}" not found in orchestrator config.`, errorCode: "node_not_found" };
  }

  const parsed = NodesMapSchema.safeParse({ [nodeName]: nodeEntries[nodeName] });
  if (!parsed.success) {
    return {
      ok: false,
      error: `Node "${nodeName}" has invalid config: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      errorCode: "node_unresolvable",
    };
  }

  const nodeConfig = parsed.data[nodeName]!;
  const resolved = resolveNodePath(nodeConfig.path, pinnedRoot);

  if (!resolved.resolved) {
    return {
      ok: false,
      error: `Node "${nodeName}" path unresolvable: ${resolved.reason}`,
      errorCode: "node_unresolvable",
    };
  }

  return { ok: true, root: resolved.absolutePath };
}

export function checkNodeWritePermission(pinnedRoot: string, config?: Record<string, unknown>): boolean {
  if (!config) {
    config = readOrchestratorConfig(pinnedRoot) ?? undefined;
    if (!config) return false;
  }
  const federation = config.federation as Record<string, unknown> | undefined;
  return federation?.allowNodeWrites === true;
}

