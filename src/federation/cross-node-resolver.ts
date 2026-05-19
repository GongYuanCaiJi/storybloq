import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ticket } from "../models/ticket.js";
import type { ResolvedNode } from "./resolver.js";

export type CrossNodeRefStatus =
  | { resolved: true; status: "complete" | "open" | "inprogress" }
  | { resolved: false; reason: string };

const CROSS_NODE_REF_PATTERN = /^([a-z][a-z0-9_-]{0,63}):(T-\d+[a-z]?|ISS-\d+)$/;

export class CrossNodeBlockingResolver {
  private constructor(private readonly statuses: Map<string, CrossNodeRefStatus>) {}

  static async build(
    tickets: readonly Ticket[],
    resolvedNodes: Map<string, ResolvedNode>,
  ): Promise<CrossNodeBlockingResolver> {
    const refsByNode = new Map<string, Set<string>>();

    for (const ticket of tickets) {
      const refs = (ticket as Record<string, unknown>).crossNodeBlockedBy;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== "string") continue;
        const match = CROSS_NODE_REF_PATTERN.exec(ref);
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
        const reason = node && !node.resolved ? node.reason : "node not configured";
        for (const itemId of itemIds) {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason });
        }
        continue;
      }

      const nodeTicketStatuses = new Map<string, string>();
      const nodeIssueStatuses = new Map<string, string>();

      try {
        const ticketsDir = join(node.storyDir, "tickets");
        const ticketFiles = await readdir(ticketsDir).catch(() => [] as string[]);
        for (const f of ticketFiles.filter((f) => f.endsWith(".json"))) {
          try {
            const raw = await readFile(join(ticketsDir, f), "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (typeof parsed.id === "string" && typeof parsed.status === "string") {
              nodeTicketStatuses.set(parsed.id, parsed.status);
            }
          } catch { /* corrupt file, skip */ }
        }

        const issuesDir = join(node.storyDir, "issues");
        const issueFiles = await readdir(issuesDir).catch(() => [] as string[]);
        for (const f of issueFiles.filter((f) => f.endsWith(".json"))) {
          try {
            const raw = await readFile(join(issuesDir, f), "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (typeof parsed.id === "string" && typeof parsed.status === "string") {
              nodeIssueStatuses.set(parsed.id, parsed.status);
            }
          } catch { /* corrupt file, skip */ }
        }
      } catch {
        for (const itemId of itemIds) {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason: "scan error" });
        }
        continue;
      }

      for (const itemId of itemIds) {
        const isTicket = itemId.startsWith("T-");
        const statusMap = isTicket ? nodeTicketStatuses : nodeIssueStatuses;
        const itemStatus = statusMap.get(itemId);

        if (!itemStatus) {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason: "item not found in node" });
        } else {
          const normalized = itemStatus === "complete" || itemStatus === "resolved"
            ? "complete"
            : itemStatus === "inprogress"
              ? "inprogress"
              : "open";
          statuses.set(`${nodeName}:${itemId}`, { resolved: true, status: normalized });
        }
      }
    }

    return new CrossNodeBlockingResolver(statuses);
  }

  isCrossNodeBlocked(ticket: Ticket): boolean | "unresolved" {
    const refs = (ticket as Record<string, unknown>).crossNodeBlockedBy;
    if (!Array.isArray(refs) || refs.length === 0) return false;

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
}
