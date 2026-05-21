import { join } from "node:path";
import type { FederationState } from "./state.js";
import type { Recommendation } from "../core/recommend.js";
import { recommend } from "../core/recommend.js";
import { loadNodeFullState } from "./scanner.js";

export interface NodeRecommendationLoadWarning {
  readonly node: string;
  readonly root: string | null;
  readonly reason: string;
}

export interface NodeRecommendationsLoadResult {
  readonly recommendationsByNode: Map<string, { root: string; recommendations: readonly Recommendation[] }>;
  readonly warnings: readonly NodeRecommendationLoadWarning[];
}

export async function loadNodeRecommendations(
  fedState: FederationState,
  count: number,
  crossNodeRefStatuses?: Record<string, string>,
): Promise<NodeRecommendationsLoadResult> {
  const recommendationsByNode = new Map<string, { root: string; recommendations: readonly Recommendation[] }>();
  const warnings: NodeRecommendationLoadWarning[] = [];

  for (const node of fedState.nodes) {
    if (!node.reachable) continue;
    if (!node.resolvedPath) {
      warnings.push({
        node: node.name,
        root: null,
        reason: "reachable node has no resolved path",
      });
      continue;
    }

    try {
      const storyDir = join(node.resolvedPath, ".story");
      const { state } = await loadNodeFullState(storyDir);
      const { recommendations } = recommend(
        state,
        count,
        crossNodeRefStatuses ? { crossNodeRefStatuses } : undefined,
      );
      recommendationsByNode.set(node.name, { root: node.resolvedPath, recommendations });
    } catch (err) {
      warnings.push({
        node: node.name,
        root: node.resolvedPath,
        reason: summarizeError(err),
      });
    }
  }

  return { recommendationsByNode, warnings };
}

function summarizeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "failed to load node recommendations";
}
