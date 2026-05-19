import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FederationState } from "./state.js";

export interface CachedNodeSummary {
  ticketCount: number;
  openTickets: number;
  issueCount: number;
  openIssues: number;
  lastHandoverDate: string | null;
  lastHandoverTitle: string | null;
  reachable: boolean;
  unreachableReason?: string;
}

export interface FederationCache {
  lastScanTimestamp: string;
  nodes: Record<string, CachedNodeSummary>;
}

const CACHE_FILENAME = "federation-cache.json";

export function readFederationCache(storyDir: string): FederationCache | null {
  const cachePath = join(storyDir, CACHE_FILENAME);
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as FederationCache;
    if (!parsed.lastScanTimestamp || !parsed.nodes) return null;
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError && existsSync(cachePath)) {
      try { unlinkSync(cachePath); } catch { /* ignore */ }
    }
    return null;
  }
}

export function writeFederationCache(storyDir: string, state: FederationState): void {
  const cache: FederationCache = {
    lastScanTimestamp: state.lastScanTimestamp,
    nodes: {},
  };

  for (const entry of state.nodes) {
    const summary: CachedNodeSummary = {
      ticketCount: entry.scanSummary?.ticketCount ?? 0,
      openTickets: entry.scanSummary?.openTickets ?? 0,
      issueCount: entry.scanSummary?.issueCount ?? 0,
      openIssues: entry.scanSummary?.openIssues ?? 0,
      lastHandoverDate: entry.scanSummary?.lastHandoverDate ?? null,
      lastHandoverTitle: entry.scanSummary?.lastHandoverTitle ?? null,
      reachable: entry.reachable,
    };
    if (!entry.reachable && entry.unreachableReason) {
      summary.unreachableReason = entry.unreachableReason;
    }
    cache.nodes[entry.name] = summary;
  }

  const cachePath = join(storyDir, CACHE_FILENAME);
  const tmpPath = `${cachePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmpPath, cachePath);
}
