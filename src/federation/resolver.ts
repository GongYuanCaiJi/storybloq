import { realpathSync, accessSync, existsSync, constants } from "node:fs";
import { join, normalize, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export type ResolvedNode =
  | { resolved: true; absolutePath: string; storyDir: string; rawPath: string }
  | { resolved: false; reason: string; rawPath: string };

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function resolveNodePath(rawPath: string, orchestratorRoot: string): ResolvedNode {
  const expanded = expandTilde(rawPath);
  const candidate = isAbsolute(expanded) ? expanded : resolve(expandTilde(orchestratorRoot), expanded);

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
  try {
    orchResolved = realpathSync(expandTilde(orchestratorRoot));
  } catch {
    orchResolved = normalize(expandTilde(orchestratorRoot));
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
    return { resolved: false, reason: "no .story/config.json found", rawPath };
  }

  return { resolved: true, absolutePath: resolved, storyDir, rawPath };
}

export function resolveAllNodes(
  nodes: Record<string, { path: string }>,
  orchestratorRoot: string,
): Map<string, ResolvedNode> {
  const results = new Map<string, ResolvedNode>();
  for (const [name, node] of Object.entries(nodes)) {
    results.set(name, resolveNodePath(node.path, orchestratorRoot));
  }
  return results;
}
