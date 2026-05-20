import { join } from "node:path";
import type { ResolvedNode } from "./resolver.js";
import { findLatestHandover } from "./handover-utils.js";

export interface HandoverDigestEntry {
  nodeName: string;
  heading: string | null;
  date: string | null;
  filename: string | null;
}

export async function buildHandoverDigest(
  resolvedNodes: Map<string, ResolvedNode>,
): Promise<HandoverDigestEntry[]> {
  const tasks = Array.from(resolvedNodes.entries()).map(async ([name, node]): Promise<HandoverDigestEntry> => {
    if (!node.resolved) {
      return { nodeName: name, heading: null, date: null, filename: null };
    }

    try {
      const info = await findLatestHandover(join(node.storyDir, "handovers"));
      if (!info) {
        return { nodeName: name, heading: null, date: null, filename: null };
      }
      return { nodeName: name, heading: info.heading, date: info.date, filename: info.filename };
    } catch {
      return { nodeName: name, heading: null, date: null, filename: null };
    }
  });

  return Promise.all(tasks);
}
