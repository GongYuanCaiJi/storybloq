import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodePath } from "../federation/resolver.js";
import { NodesMapSchema } from "../models/federation-config.js";

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export type NodeResolutionResult =
  | { ok: true; root: string }
  | { ok: false; error: string; errorCode: string };

export function resolveNodeRoot(
  pinnedRoot: string,
  nodeName: string,
): NodeResolutionResult {
  const configPath = join(pinnedRoot, ".story", "config.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Cannot read orchestrator config", errorCode: "io_error" };
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

export function checkNodeWritePermission(pinnedRoot: string): boolean {
  const configPath = join(pinnedRoot, ".story", "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const federation = config.federation as Record<string, unknown> | undefined;
    return federation?.allowNodeWrites === true;
  } catch {
    return false;
  }
}

function makeErrorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function withNodeReadResolution(
  pinnedRoot: string,
  nodeName: string | undefined,
  handler: (root: string) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (!nodeName) {
    return handler(pinnedRoot);
  }

  const resolved = resolveNodeRoot(pinnedRoot, nodeName);
  if (!resolved.ok) {
    return makeErrorResult(resolved.error);
  }

  return handler(resolved.root);
}

export async function withNodeWriteResolution(
  pinnedRoot: string,
  nodeName: string | undefined,
  handler: (root: string) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (!nodeName) {
    return handler(pinnedRoot);
  }

  if (!checkNodeWritePermission(pinnedRoot)) {
    return makeErrorResult(
      `Node writes disabled. Set \`federation.allowNodeWrites: true\` in .story/config.json to enable cross-node writes from this orchestrator.`,
    );
  }

  const resolved = resolveNodeRoot(pinnedRoot, nodeName);
  if (!resolved.ok) {
    return makeErrorResult(resolved.error);
  }

  return handler(resolved.root);
}
