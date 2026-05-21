import { readdirSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { recommend, type RecommendOptions } from "../../core/recommend.js";
import { formatRecommendations } from "../../core/output-formatter.js";
import { loadFederationState } from "../../federation/recommend-loader.js";
import { readFederationCache } from "../../federation/cache.js";
import type { CommandContext, CommandResult } from "../types.js";

export async function handleRecommend(ctx: CommandContext, count: number): Promise<CommandResult> {
  const baseOptions = buildRecommendOptions(ctx);
  const fedState = await loadFederationState(ctx.root, ctx.state.config);
  const cache = readFederationCache(join(ctx.root, ".story"));
  const options: RecommendOptions = {
    ...baseOptions,
    ...(fedState ? { federationState: fedState } : {}),
    ...(cache?.crossNodeRefStatuses ? { crossNodeRefStatuses: cache.crossNodeRefStatuses } : {}),
  };
  const result = recommend(ctx.state, count, options);
  return { output: formatRecommendations(result, ctx.state, ctx.format) };
}

function buildRecommendOptions(ctx: CommandContext): RecommendOptions {
  const opts: { latestHandoverContent?: string; previousOpenIssueCount?: number } = {};

  // ISS-018: Load latest handover content
  try {
    const files = readdirSync(ctx.handoversDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length > 0) {
      const handoverResult = tryReadFile(join(ctx.handoversDir, files[files.length - 1]));
      if (handoverResult.ok) opts.latestHandoverContent = handoverResult.content;
    }
  } catch { /* no handovers */ }

  // ISS-019: Load previous open issue count from latest snapshot
  try {
    const snapshotsDir = join(ctx.root, ".story", "snapshots");
    const snapFiles = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json")).sort();
    if (snapFiles.length > 0) {
      const snapResult = tryReadFile(join(snapshotsDir, snapFiles[snapFiles.length - 1]));
      if (!snapResult.ok) return opts;
      const raw = snapResult.content;
      const snap = JSON.parse(raw) as { issues?: Array<{ status?: string }> };
      if (snap.issues) {
        opts.previousOpenIssueCount = snap.issues.filter((i) => i.status !== "resolved").length;
      }
    }
  } catch { /* no snapshots */ }

  return opts;
}
