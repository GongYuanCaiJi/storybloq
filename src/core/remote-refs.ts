import type { ProjectState } from "./project-state.js";
import { nextTicketID, nextIssueID, nextNoteID, nextLessonID } from "./id-allocation.js";

export interface AllocationResult {
  displayId: string;
  reserved: boolean;
}

export function allocateDisplayId(
  type: "ticket" | "issue" | "note" | "lesson",
  state: ProjectState,
): AllocationResult {
  const allocator = state.config.team?.idAllocator;

  if (allocator === "git-refs") {
    throw new Error(
      "git-refs allocation requires a remote. Use reserveDisplayId() for async allocation, or set team.idAllocator to \"local\".",
    );
  }

  const displayId = localNextId(type, state);
  return { displayId, reserved: false };
}

function localNextId(type: "ticket" | "issue" | "note" | "lesson", state: ProjectState): string {
  switch (type) {
    case "ticket": return nextTicketID(state.tickets);
    case "issue": return nextIssueID(state.issues);
    case "note": return nextNoteID(state.notes);
    case "lesson": return nextLessonID(state.lessons);
  }
}

export async function reserveDisplayId(
  root: string,
  type: "ticket" | "issue" | "note" | "lesson",
  state: ProjectState,
): Promise<AllocationResult> {
  const remote = state.config.team?.idAllocatorRemote ?? "origin";
  const prefix = typeToPrefix(type);
  const refNamespace = `refs/tags/storybloq/ids/${type}s`;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync("git", [
      "fetch", remote, `+${refNamespace}/*:${refNamespace}/*`,
    ], { cwd: root, timeout: 15000 });
  } catch (err) {
    throw new Error(
      `Cannot reach remote "${remote}" for git-refs ID allocation. ` +
      `Check network connectivity and tag-push permissions, or set team.idAllocator to "local".`,
    );
  }

  const { stdout } = await execFileAsync("git", [
    "tag", "-l", `storybloq/ids/${type}s/${prefix}-*`,
  ], { cwd: root, timeout: 5000 });

  const existingTags = stdout.split("\n").filter((l) => l.trim().length > 0);
  const existingNums = new Set<number>();
  const numRegex = new RegExp(`^storybloq/ids/${type}s/${prefix}-(\\d+)$`);
  for (const tag of existingTags) {
    const match = tag.match(numRegex);
    if (match?.[1]) existingNums.add(parseInt(match[1], 10));
  }

  const localMax = localMaxNum(type, state);
  let next = Math.max(localMax, ...existingNums) + 1;

  for (let attempt = 0; attempt < 5; attempt++) {
    const displayId = `${prefix}-${String(next).padStart(3, "0")}`;
    const tagName = `storybloq/ids/${type}s/${displayId}`;

    try {
      await execFileAsync("git", ["tag", tagName], { cwd: root, timeout: 5000 });
    } catch (tagErr) {
      const tagStderr = (tagErr as { stderr?: string }).stderr ?? "";
      if (tagStderr.includes("already exists")) {
        next++;
        continue;
      }
      throw new Error(
        `Failed to create local tag "${tagName}": ${tagStderr || (tagErr instanceof Error ? tagErr.message : String(tagErr))}`,
      );
    }

    try {
      await execFileAsync("git", [
        "push", remote, `refs/tags/${tagName}`,
      ], { cwd: root, timeout: 15000 });
      return { displayId, reserved: true };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      if (stderr.includes("already exists") || stderr.includes("would clobber existing tag")) {
        await execFileAsync("git", ["tag", "-d", tagName], { cwd: root, timeout: 5000 }).catch(() => {});
        next++;
        continue;
      }
      throw new Error(
        `Failed to push tag "${tagName}" to remote "${remote}". Local tag "${tagName}" preserved for manual retry. ${stderr || (err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  throw new Error(`Failed to reserve ${type} display ID after 5 attempts on remote "${remote}".`);
}

function typeToPrefix(type: "ticket" | "issue" | "note" | "lesson"): string {
  switch (type) {
    case "ticket": return "T";
    case "issue": return "ISS";
    case "note": return "N";
    case "lesson": return "L";
  }
}

function localMaxNum(type: "ticket" | "issue" | "note" | "lesson", state: ProjectState): number {
  const regexMap = {
    ticket: /^T-(\d+)/,
    issue: /^ISS-(\d+)/,
    note: /^N-(\d+)/,
    lesson: /^L-(\d+)/,
  };
  const regex = regexMap[type];
  const collection = type === "ticket" ? state.tickets : type === "issue" ? state.issues : type === "note" ? state.notes : state.lessons;
  let max = 0;
  for (const item of collection) {
    const match = item.id.match(regex);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max;
}

export async function listReservations(
  root: string,
  type: "ticket" | "issue" | "note" | "lesson",
  state: ProjectState,
): Promise<Array<{ displayId: string; tagName: string }>> {
  const remote = state.config.team?.idAllocatorRemote ?? "origin";
  const refNamespace = `refs/tags/storybloq/ids/${type}s`;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("git", [
    "fetch", remote, `+${refNamespace}/*:${refNamespace}/*`,
  ], { cwd: root, timeout: 15000 });

  const { stdout } = await execFileAsync("git", [
    "tag", "-l", `storybloq/ids/${type}s/*`,
  ], { cwd: root, timeout: 5000 });

  return stdout.split("\n")
    .filter((l) => l.trim().length > 0)
    .map((tag) => ({
      displayId: tag.replace(`storybloq/ids/${type}s/`, ""),
      tagName: tag.trim(),
    }));
}
