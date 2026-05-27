import { computeReconcilePlan, computeRebalancePlan, type ReconcileRename } from "../../core/reconcile.js";
import { formatReconcileResult, ExitCode } from "../../core/output-formatter.js";
import { withProjectLock, runTransactionUnlocked } from "../../core/project-loader.js";
import { nextNoteID, allocateTeamNoteId, maxSequentialNumber } from "../../core/id-allocation.js";
import type { Note } from "../../models/note.js";
import type { CommandResult } from "../types.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const NOTE_NUMERIC_REGEX = /^N-(\d+)$/;

export interface ReconcileOptions {
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly rebalanceRanks?: boolean;
  readonly format: "md" | "json";
}

const ENTITY_DIRS: Record<string, string> = {
  ticket: "tickets",
  issue: "issues",
  note: "notes",
  lesson: "lessons",
};

interface RankChange {
  id: string;
  entityType: string;
  newRank: string;
}

async function applyChanges(
  root: string,
  renames: ReconcileRename[],
  rankChanges: RankChange[],
  extraOps?: Array<{ op: "write"; target: string; content: string }>,
): Promise<void> {
  const storyDir = join(root, ".story");
  const operations: Array<{ op: "write"; target: string; content: string }> = [];

  const rankById = new Map<string, string>();
  for (const c of rankChanges) rankById.set(c.id, c.newRank);

  const handled = new Set<string>();

  for (const rename of renames) {
    const dir = ENTITY_DIRS[rename.entityType];
    if (!dir) continue;
    const files = await readdir(join(storyDir, dir));
    const match = files.find((f) => f.endsWith(".json") && f.replace(/\.json$/, "") === rename.id);
    if (!match) continue;
    const filePath = join(storyDir, dir, match);
    const raw = await readFile(filePath, "utf-8");
    const entity = JSON.parse(raw) as Record<string, unknown>;
    entity.displayId = rename.newDisplayId;
    const prev = Array.isArray(entity.previousDisplayIds) ? [...entity.previousDisplayIds] : [];
    if (!prev.includes(rename.oldDisplayId)) prev.push(rename.oldDisplayId);
    entity.previousDisplayIds = prev;
    const newRank = rankById.get(rename.id);
    if (newRank !== undefined) entity.rank = newRank;
    operations.push({ op: "write", target: filePath, content: JSON.stringify(entity, null, 2) + "\n" });
    handled.add(rename.id);
  }

  for (const change of rankChanges) {
    if (handled.has(change.id)) continue;
    const dir = ENTITY_DIRS[change.entityType];
    if (!dir) continue;
    const filePath = join(storyDir, dir, `${change.id}.json`);
    const raw = await readFile(filePath, "utf-8");
    const entity = JSON.parse(raw) as Record<string, unknown>;
    entity.rank = change.newRank;
    operations.push({ op: "write", target: filePath, content: JSON.stringify(entity, null, 2) + "\n" });
  }

  const renameMap = new Map<string, string>();
  for (const rename of renames) {
    renameMap.set(rename.oldDisplayId, rename.newDisplayId);
  }
  if (renameMap.size > 0) {
    const allDirs = ["tickets", "issues"];
    for (const dirName of allDirs) {
      const dirPath = join(storyDir, dirName);
      let dirFiles: string[];
      try { dirFiles = await readdir(dirPath); } catch { continue; }
      for (const fname of dirFiles) {
        if (!fname.endsWith(".json")) continue;
        const entityId = fname.replace(/\.json$/, "");
        if (handled.has(entityId)) continue;
        const fpath = join(dirPath, fname);
        const rawContent = await readFile(fpath, "utf-8");
        const obj = JSON.parse(rawContent) as Record<string, unknown>;
        let changed = false;
        if (Array.isArray(obj.blockedBy)) {
          const updated = obj.blockedBy.map((ref: unknown) => {
            const mapped = typeof ref === "string" ? renameMap.get(ref) : undefined;
            if (mapped) { changed = true; return mapped; }
            return ref;
          });
          if (changed) obj.blockedBy = updated;
        }
        if (typeof obj.parentTicket === "string" && renameMap.has(obj.parentTicket)) {
          obj.parentTicket = renameMap.get(obj.parentTicket);
          changed = true;
        }
        if (Array.isArray(obj.relatedTickets)) {
          const updated = obj.relatedTickets.map((ref: unknown) => {
            const mapped = typeof ref === "string" ? renameMap.get(ref) : undefined;
            if (mapped) { changed = true; return mapped; }
            return ref;
          });
          if (changed) obj.relatedTickets = updated;
        }
        if (changed) {
          operations.push({ op: "write", target: fpath, content: JSON.stringify(obj, null, 2) + "\n" });
        }
      }
    }
  }

  if (extraOps) operations.push(...extraOps);
  if (operations.length > 0) {
    await runTransactionUnlocked(root, operations);
  }
}

export async function handleReconcile(
  root: string,
  options: ReconcileOptions,
): Promise<CommandResult> {
  let output = "";
  let exitCode: number = ExitCode.OK;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const result = computeReconcilePlan(state);

    if (!result.ok) {
      output = formatReconcileResult(result, options.format);
      exitCode = ExitCode.ERROR;
      return;
    }

    if (options.ci) {
      if (result.plan.renames.length > 0) {
        output = formatReconcileResult(result, options.format);
        exitCode = 1;
      } else {
        output = "No duplicate displayIds found. Project is clean.";
        exitCode = ExitCode.OK;
      }
      return;
    }

    if (options.dryRun || result.plan.renames.length === 0) {
      output = formatReconcileResult(result, options.format);
      exitCode = ExitCode.OK;
      return;
    }

    const lines = [
      "# Reconcile Mapping",
      "",
      `Reconciled ${result.plan.renames.length} duplicate displayId(s).`,
      "",
      "| Entity | Old DisplayId | New DisplayId | Reason |",
      "|--------|--------------|--------------|--------|",
    ];
    for (const r of result.plan.renames) {
      lines.push(`| ${r.id} | ${r.oldDisplayId} | ${r.newDisplayId} | ${r.reason} |`);
    }
    const isTeam = state.config.team?.enabled === true;
    let noteId: string;
    let noteDisplayId: string | undefined;
    if (isTeam) {
      const alloc = allocateTeamNoteId(state.notes);
      noteId = alloc.id;
      const maxFromNoteRenames = result.plan.renames
        .filter((r) => r.entityType === "note")
        .reduce((max, r) => {
          const m = r.newDisplayId.match(NOTE_NUMERIC_REGEX);
          return m?.[1] ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
      const allocNum = parseInt(alloc.displayId.replace(/^N-0*/, ""), 10) || 0;
      noteDisplayId = `N-${String(Math.max(allocNum, maxFromNoteRenames + 1)).padStart(3, "0")}`;
    } else {
      noteId = nextNoteID(state.notes);
      noteDisplayId = undefined;
    }
    const today = new Date().toISOString().slice(0, 10);
    const note: Note = {
      id: noteId,
      ...(noteDisplayId != null && { displayId: noteDisplayId }),
      title: "Reconcile mapping",
      content: lines.join("\n"),
      tags: ["reconcile"],
      status: "active",
      createdDate: today,
      updatedDate: today,
    };
    const noteFilePath = join(root, ".story", "notes", `${noteId}.json`);
    const noteOp = { op: "write" as const, target: noteFilePath, content: JSON.stringify(note, null, 2) + "\n" };

    let rankChanges: RankChange[] = [];
    let rebalanceMsg = "";
    if (options.rebalanceRanks) {
      const rebalance = computeRebalancePlan(state);
      if (rebalance.changes.length > 0) {
        rankChanges = rebalance.changes;
        rebalanceMsg = `\nRebalanced ${rebalance.changes.length} rank(s) across ${rebalance.phasesRebalanced} phase(s).`;
      }
    }

    await applyChanges(root, result.plan.renames, rankChanges, [noteOp]);

    output = formatReconcileResult(result, options.format) + rebalanceMsg;
    exitCode = ExitCode.OK;
  });

  return { output, exitCode };
}
