import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import type { Ticket } from "../models/ticket.js";
import type { ResolvedNode } from "./resolver.js";

export type CrossNodeRefStatus =
  | { resolved: true; status: "complete" | "open" | "inprogress" }
  | { resolved: false; reason: string };


function normalizeStatus(status: string): "complete" | "open" | "inprogress" {
  if (status === "complete" || status === "resolved") return "complete";
  if (status === "inprogress") return "inprogress";
  return "open";
}

export class CrossNodeBlockingResolver {
  private constructor(private readonly statuses: Map<string, CrossNodeRefStatus>) {}

  static async build(
    tickets: readonly Ticket[],
    resolvedNodes: Map<string, ResolvedNode>,
  ): Promise<CrossNodeBlockingResolver> {
    const refsByNode = new Map<string, Set<string>>();

    for (const ticket of tickets) {
      const refs = ticket.crossNodeBlockedBy;
      if (!refs) continue;
      for (const ref of refs) {
        const match = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
        if (!match) continue;
        const nodeName = match[1]!;
        const itemId = match[2]!;
        if (!refsByNode.has(nodeName)) refsByNode.set(nodeName, new Set());
        refsByNode.get(nodeName)!.add(itemId);
      }
    }

    const statuses = new Map<string, CrossNodeRefStatus>();

    for (const [nodeName, itemIds] of refsByNode) {
      const node = resolvedNodes.get(nodeName);

      if (!node || !node.resolved) {
        const reason = node?.reason ?? "node not configured";
        for (const itemId of itemIds) {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason });
        }
        continue;
      }

      const reads = Array.from(itemIds).map(async (itemId) => {
        const isTicket = itemId.startsWith("T-");
        const dir = join(node.storyDir, isTicket ? "tickets" : "issues");
        try {
          const raw = await readFile(join(dir, `${itemId}.json`), "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.status === "string") {
            statuses.set(`${nodeName}:${itemId}`, { resolved: true, status: normalizeStatus(parsed.status) });
          } else {
            statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason: "item not found in node" });
          }
        } catch {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason: "item not found in node" });
        }
      });

      await Promise.all(reads);
    }

    return new CrossNodeBlockingResolver(statuses);
  }

  isCrossNodeBlocked(ticket: Ticket): boolean | "unresolved" {
    const refs = ticket.crossNodeBlockedBy;
    if (!refs || refs.length === 0) return false;

    let hasUnresolved = false;

    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      const status = this.statuses.get(ref);
      if (!status) {
        hasUnresolved = true;
        continue;
      }

      if (!status.resolved) {
        hasUnresolved = true;
        continue;
      }

      if (status.status !== "complete") {
        return true;
      }
    }

    return hasUnresolved ? "unresolved" : false;
  }

  getCrossNodeStatus(ref: string): CrossNodeRefStatus | undefined {
    return this.statuses.get(ref);
  }

  get resolvedStatuses(): ReadonlyMap<string, CrossNodeRefStatus> {
    return this.statuses;
  }
}
