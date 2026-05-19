import type { Config } from "../models/config.js";
import type { NodeHealth } from "../models/federation-config.js";
import type { ResolvedNode } from "./resolver.js";
import type { NodeScanResult, NodeScanSummary } from "./scanner.js";

export interface FederationNodeEntry {
  name: string;
  rawPath: string;
  resolvedPath: string | null;
  health: NodeHealth;
  role: string;
  summary: string;
  dependsOn: string[];
  reachable: boolean;
  scanSummary?: NodeScanSummary;
  unreachableReason?: string;
}

export interface FederationState {
  orchestratorProject: string;
  nodeCount: number;
  reachableCount: number;
  unreachableCount: number;
  nodes: FederationNodeEntry[];
  totalTickets: number;
  totalOpenTickets: number;
  totalCompleteTickets: number;
  totalIssues: number;
  totalOpenIssues: number;
  lastScanTimestamp: string;
}

/** Kahn's topological sort. On cycle, appends cycle nodes alphabetically at the end (no error). */
export function topologicalSortNodes(
  nodes: Record<string, { dependsOn?: string[] }>,
): string[] {
  const keys = Object.keys(nodes);
  if (keys.length === 0) return [];

  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const key of keys) {
    inDegree.set(key, 0);
    adjList.set(key, []);
  }

  for (const [key, node] of Object.entries(nodes)) {
    for (const dep of node.dependsOn ?? []) {
      if (inDegree.has(dep)) {
        adjList.get(dep)!.push(key);
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const dependent of adjList.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        const insertIdx = queue.findIndex((q) => q > dependent);
        if (insertIdx === -1) queue.push(dependent);
        else queue.splice(insertIdx, 0, dependent);
      }
    }
  }

  if (result.length < keys.length) {
    const remaining = keys.filter((k) => !result.includes(k)).sort();
    result.push(...remaining);
  }

  return result;
}

export function buildFederationState(
  config: Config,
  resolvedNodes: Map<string, ResolvedNode>,
  scanResults: Map<string, NodeScanResult>,
): FederationState {
  const nodesConfig = (config.nodes ?? {}) as Record<string, Record<string, unknown>>;

  const sortedNames = topologicalSortNodes(
    Object.fromEntries(
      Object.entries(nodesConfig).map(([k, v]) => [
        k,
        { dependsOn: Array.isArray(v.dependsOn) ? (v.dependsOn as string[]) : [] },
      ]),
    ),
  );

  let totalTickets = 0;
  let totalOpenTickets = 0;
  let totalCompleteTickets = 0;
  let totalIssues = 0;
  let totalOpenIssues = 0;
  let reachableCount = 0;
  let unreachableCount = 0;

  const entries: FederationNodeEntry[] = [];

  for (const name of sortedNames) {
    const nodeConf = nodesConfig[name] ?? {};
    const resolved = resolvedNodes.get(name);
    const scan = scanResults.get(name);

    const entry: FederationNodeEntry = {
      name,
      rawPath: typeof nodeConf.path === "string" ? nodeConf.path : "",
      resolvedPath: resolved?.resolved ? resolved.absolutePath : null,
      health: (typeof nodeConf.health === "string" ? nodeConf.health : "grey") as NodeHealth,
      role: typeof nodeConf.role === "string" ? nodeConf.role : "",
      summary: typeof nodeConf.summary === "string" ? nodeConf.summary : "",
      dependsOn: Array.isArray(nodeConf.dependsOn) ? (nodeConf.dependsOn as string[]) : [],
      reachable: false,
    };

    if (scan?.reachable) {
      entry.reachable = true;
      entry.scanSummary = scan.summary;
      reachableCount++;
      totalTickets += scan.summary.ticketCount;
      totalOpenTickets += scan.summary.openTickets;
      totalCompleteTickets += scan.summary.completeTickets;
      totalIssues += scan.summary.issueCount;
      totalOpenIssues += scan.summary.openIssues;
    } else {
      unreachableCount++;
      entry.unreachableReason = scan && !scan.reachable ? scan.reason : "unknown";
    }

    entries.push(entry);
  }

  return {
    orchestratorProject: config.project,
    nodeCount: sortedNames.length,
    reachableCount,
    unreachableCount,
    nodes: entries,
    totalTickets,
    totalOpenTickets,
    totalCompleteTickets,
    totalIssues,
    totalOpenIssues,
    lastScanTimestamp: new Date().toISOString(),
  };
}
