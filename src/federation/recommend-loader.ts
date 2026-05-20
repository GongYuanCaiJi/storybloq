import { join } from "node:path";
import type { Config } from "../models/config.js";
import type { FederationState, FederationNodeEntry } from "./state.js";
import type { NodeHealth } from "../models/federation-config.js";
import type { NodeScanSummary } from "./scanner.js";
import { readFederationCache, writeFederationCache, type FederationCache } from "./cache.js";
import { resolveAllNodes } from "./resolver.js";
import { scanAllSummaries } from "./scanner.js";
import { buildFederationState } from "./state.js";

const FEDERATION_CACHE_TTL_MS = 300_000;

function extractNodeEntries(
  config: Config,
): Record<string, { path: string }> | null {
  const nodes = config.nodes as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes !== "object" || Object.keys(nodes).length === 0) return null;
  return Object.fromEntries(
    Object.entries(nodes)
      .filter(([, v]) => v != null && typeof v === "object")
      .map(([k, v]) => [k, { path: typeof (v as Record<string, unknown>).path === "string" ? (v as Record<string, unknown>).path as string : "" }]),
  );
}

function reconstructFromCache(
  cache: FederationCache,
  config: Config,
): FederationState | null {
  const nodesConfig = (config.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const entries: FederationNodeEntry[] = [];
  let totalTickets = 0;
  let totalOpenTickets = 0;
  let totalCompleteTickets = 0;
  let totalIssues = 0;
  let totalOpenIssues = 0;
  let reachableCount = 0;
  let unreachableCount = 0;

  for (const [name, cached] of Object.entries(cache.nodes)) {
    const nodeConf = nodesConfig[name] ?? {};
    const scanSummary: NodeScanSummary | undefined = cached.reachable
      ? {
          project: name,
          type: "unknown",
          ticketCount: cached.ticketCount,
          openTickets: cached.openTickets,
          completeTickets: cached.completeTickets ?? 0,
          issueCount: cached.issueCount,
          openIssues: cached.openIssues,
          lastHandoverDate: cached.lastHandoverDate,
          lastHandoverTitle: cached.lastHandoverTitle,
        }
      : undefined;

    const entry: FederationNodeEntry = {
      name,
      rawPath: typeof nodeConf.path === "string" ? nodeConf.path : "",
      resolvedPath: null,
      health: (typeof nodeConf.health === "string" ? nodeConf.health : "grey") as NodeHealth,
      role: typeof nodeConf.role === "string" ? nodeConf.role : "",
      summary: typeof nodeConf.summary === "string" ? nodeConf.summary : "",
      dependsOn: Array.isArray(nodeConf.dependsOn) ? (nodeConf.dependsOn as string[]) : [],
      reachable: cached.reachable,
      scanSummary,
      unreachableReason: cached.unreachableReason,
    };
    entries.push(entry);

    if (cached.reachable && scanSummary) {
      reachableCount++;
      totalTickets += scanSummary.ticketCount;
      totalOpenTickets += scanSummary.openTickets;
      totalCompleteTickets += scanSummary.completeTickets;
      totalIssues += scanSummary.issueCount;
      totalOpenIssues += scanSummary.openIssues;
    } else {
      unreachableCount++;
    }
  }

  if (entries.length === 0) return null;

  return {
    orchestratorProject: config.project,
    nodeCount: entries.length,
    reachableCount,
    unreachableCount,
    nodes: entries,
    totalTickets,
    totalOpenTickets,
    totalCompleteTickets,
    totalIssues,
    totalOpenIssues,
    lastScanTimestamp: cache.lastScanTimestamp,
  };
}

export async function loadFederationState(
  root: string,
  config: Config,
): Promise<FederationState | undefined> {
  try {
    if (config.type !== "orchestrator") return undefined;
    const nodeEntries = extractNodeEntries(config);
    if (!nodeEntries) return undefined;

    const storyDir = join(root, ".story");
    const cache = readFederationCache(storyDir);

    if (cache) {
      const age = Date.now() - new Date(cache.lastScanTimestamp).getTime();
      if (age < FEDERATION_CACHE_TTL_MS && !Number.isNaN(age)) {
        const reconstructed = reconstructFromCache(cache, config);
        if (reconstructed) return reconstructed;
      }
    }

    let fedState: FederationState | undefined;
    try {
      const resolvedNodes = resolveAllNodes(nodeEntries, root);
      const scanResults = await scanAllSummaries(resolvedNodes);
      fedState = buildFederationState(config, resolvedNodes, scanResults);
      try { writeFederationCache(storyDir, fedState); } catch { /* best-effort */ }
    } catch {
      if (cache) {
        const stale = reconstructFromCache(cache, config);
        if (stale) return stale;
      }
    }

    return fedState;
  } catch {
    return undefined;
  }
}
