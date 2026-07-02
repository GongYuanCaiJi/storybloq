import type { ProjectState } from "../core/project-state.js";
import { hasConflicts } from "../core/conflicts.js";

export function checkAutonomousConflicts(state: ProjectState): string | null {
  const report = hasConflicts(state);
  if (!report.hasConflicts) return null;
  const summary = report.items.map((i) => `${i.id} (${i.conflictCount})`).join(", ");
  return (
    `Cannot proceed: ${report.items.length} item(s) have unresolved conflicts: ${summary}. ` +
    `Run \`storybloq conflicts list\` to inspect, then \`storybloq resolve <id> --use ours|theirs\` ` +
    `(for config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`), then retry.`
  );
}
