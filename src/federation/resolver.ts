import { realpathSync, accessSync, existsSync, constants } from "node:fs";
import { join, normalize, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export type ResolvedNode =
  | { resolved: true; absolutePath: string; storyDir: string; rawPath: string }
  | { resolved: false; reason: string; rawPath: string; absolutePath?: string };

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function resolveNodePath(rawPath: string, orchestratorRoot: string, preResolvedOrchRoot?: string): ResolvedNode {
  const expanded = expandTilde(rawPath);
  const expandedOrch = expandTilde(orchestratorRoot);
  const candidate = isAbsolute(expanded) ? expanded : resolve(expandedOrch, expanded);

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "path does not exist"
      : code === "EACCES" ? "permission denied"
      : `filesystem error: ${code ?? "unknown"}`;
    return { resolved: false, reason, rawPath };
  }

  let orchResolved: string;
  if (preResolvedOrchRoot) {
    orchResolved = preResolvedOrchRoot;
  } else {
    try {
      orchResolved = realpathSync(expandedOrch);
    } catch {
      orchResolved = normalize(expandedOrch);
    }
  }

  if (resolved === orchResolved) {
    return { resolved: false, reason: "self-reference", rawPath };
  }

  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    return { resolved: false, reason: "permission denied", rawPath };
  }

  const storyDir = join(resolved, ".story");
  if (!existsSync(join(storyDir, "config.json"))) {
    return { resolved: false, reason: "no .story/config.json found", rawPath, absolutePath: resolved };
  }

  return { resolved: true, absolutePath: resolved, storyDir, rawPath };
}

export function resolveAllNodes(
  nodes: Record<string, { path: string }>,
  orchestratorRoot: string,
): Map<string, ResolvedNode> {
  const expandedOrch = expandTilde(orchestratorRoot);
  let orchResolved: string;
  try {
    orchResolved = realpathSync(expandedOrch);
  } catch {
    orchResolved = normalize(expandedOrch);
  }

  const results = new Map<string, ResolvedNode>();
  for (const [name, node] of Object.entries(nodes)) {
    results.set(name, resolveNodePath(node.path, orchestratorRoot, orchResolved));
  }
  return results;
}
