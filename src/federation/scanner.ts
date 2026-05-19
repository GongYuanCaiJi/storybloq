import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import type { ResolvedNode } from "./resolver.js";
import { loadProject, type LoadResult } from "../core/project-loader.js";

export interface NodeScanSummary {
  project: string;
  type: string;
  ticketCount: number;
  openTickets: number;
  completeTickets: number;
  issueCount: number;
  openIssues: number;
  lastHandoverDate: string | null;
  lastHandoverTitle: string | null;
}

export type NodeScanResult =
  | { reachable: true; summary: NodeScanSummary }
  | { reachable: false; reason: string };

export interface ScanOptions {
  timeoutMs?: number;
}

export async function scanNodeSummary(
  storyDir: string,
  signal?: AbortSignal,
): Promise<NodeScanSummary> {
  const configRaw = await readFile(join(storyDir, "config.json"), { encoding: "utf-8", signal });
  const config = JSON.parse(configRaw) as Record<string, unknown>;

  let ticketCount = 0;
  let openTickets = 0;
  let completeTickets = 0;

  const ticketsDir = join(storyDir, "tickets");
  try {
    const ticketFiles = await readdir(ticketsDir, { signal });
    const jsonFiles = ticketFiles.filter((f) => f.endsWith(".json"));

    const reads = jsonFiles.map(async (f) => {
      try {
        const raw = await readFile(join(ticketsDir, f), { encoding: "utf-8", signal });
        const ticket = JSON.parse(raw) as Record<string, unknown>;
        ticketCount++;
        if (ticket.status === "open") openTickets++;
        else if (ticket.status === "complete") completeTickets++;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    });
    await Promise.all(reads);
  } catch {
    // no tickets directory
  }

  let issueCount = 0;
  let openIssues = 0;

  const issuesDir = join(storyDir, "issues");
  try {
    const issueFiles = await readdir(issuesDir, { signal });
    const jsonFiles = issueFiles.filter((f) => f.endsWith(".json"));

    const reads = jsonFiles.map(async (f) => {
      try {
        const raw = await readFile(join(issuesDir, f), { encoding: "utf-8", signal });
        const issue = JSON.parse(raw) as Record<string, unknown>;
        issueCount++;
        if (issue.status === "open") openIssues++;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    });
    await Promise.all(reads);
  } catch {
    // no issues directory
  }

  let lastHandoverDate: string | null = null;
  let lastHandoverTitle: string | null = null;

  const handoversDir = join(storyDir, "handovers");
  try {
    const files = await readdir(handoversDir, { signal });
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length > 0) {
      const latest = mdFiles[mdFiles.length - 1]!;
      const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
      lastHandoverDate = dateMatch ? dateMatch[1]! : null;

      try {
        const content = await readFile(join(handoversDir, latest), { encoding: "utf-8", signal });
        const titleMatch = content.match(/^#\s+(.+)/m);
        lastHandoverTitle = titleMatch ? titleMatch[1]!.trim() : null;
      } catch {
        // read error, skip title
      }
    }
  } catch {
    // no handovers directory
  }

  return {
    project: typeof config.project === "string" ? config.project : "unknown",
    type: typeof config.type === "string" ? config.type : "unknown",
    ticketCount,
    openTickets,
    completeTickets,
    issueCount,
    openIssues,
    lastHandoverDate,
    lastHandoverTitle,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function scanAllSummaries(
  nodes: Map<string, ResolvedNode>,
  options?: ScanOptions,
): Promise<Map<string, NodeScanResult>> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const results = new Map<string, NodeScanResult>();

  const promises: Array<{ name: string; promise: Promise<NodeScanResult> }> = [];

  for (const [name, node] of nodes) {
    if (!node.resolved) {
      results.set(name, { reachable: false, reason: node.reason });
      continue;
    }

    const controller = new AbortController();
    const scanPromise = withTimeout(
      scanNodeSummary(node.storyDir, controller.signal),
      timeoutMs,
      controller,
    )
      .then((summary): NodeScanResult => ({ reachable: true, summary }))
      .catch((err): NodeScanResult => ({
        reachable: false,
        reason: err instanceof Error && err.message === "timeout" ? "timeout" : `scan error: ${String(err)}`,
      }));

    promises.push({ name, promise: scanPromise });
  }

  const settled = await Promise.all(promises.map((p) => p.promise));
  for (let i = 0; i < promises.length; i++) {
    results.set(promises[i]!.name, settled[i]!);
  }

  return results;
}

export async function loadNodeFullState(storyDir: string): Promise<LoadResult> {
  const root = dirname(storyDir);
  return loadProject(root);
}
