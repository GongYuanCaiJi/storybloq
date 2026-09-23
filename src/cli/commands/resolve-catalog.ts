/**
 * T-529: `storybloq resolve capabilities|glossary`, the only writer of a
 * catalog while its `_conflicts` is open.
 *
 * Runs outside handleResolve's lock on purpose: `mutateForRepair` takes the
 * conflict-resolution lock itself, and that lock is not re-entrant. Every
 * decision is made inside the transaction, against the document as loaded
 * under the lock, and the incremental rule runs before the write.
 */

import type { CommandResult } from "../types.js";
import type { ResolveResult } from "../../core/resolve.js";
import { resolveCatalogConflicts } from "../../core/resolve-doc.js";
import {
  assertNoNewCollision,
  catalogViolations,
  resolveCatalogInvariant,
  syncInvariantRecords,
  type CatalogKey,
  type InvariantAction,
} from "../../core/resolve-catalog.js";
import { getCoupledGroups } from "../../core/field-classification.js";
import { sanitizeDisplayText, MAX_PROSE_LENGTH } from "../../core/display-text.js";
import { CATALOG_CONFLICT_IDS, type CatalogConflictType } from "../../core/conflicts.js";
import type { ConflictEntry } from "../../models/types.js";
import { capabilityCatalog } from "./capability.js";
import { glossaryCatalog, termDeletionRefusal } from "./term.js";

/**
 * The catalog flags as parsed. yargs turns a REPEATED string option into an
 * array, so the single-valued ones are checked here rather than trusted.
 */
export interface CatalogResolveInput {
  readonly field?: string;
  readonly use?: "ours" | "theirs";
  readonly value?: unknown;
  readonly entityId?: unknown;
  readonly group?: unknown;
  readonly invariant?: number;
  readonly rename?: readonly string[];
  readonly dropAlias?: readonly string[];
  readonly keep?: unknown;
  readonly format?: "md" | "json";
}

/** The flags only a catalog target accepts, for the refusal on any other target. */
export function catalogOnlyFlags(input: CatalogResolveInput): string[] {
  const flags: string[] = [];
  if (input.entityId !== undefined) flags.push("--id");
  if (input.group !== undefined) flags.push("--group");
  if (input.invariant !== undefined) flags.push("--invariant");
  if (input.rename !== undefined) flags.push("--rename");
  if (input.dropAlias !== undefined) flags.push("--drop-alias");
  if (input.keep !== undefined) flags.push("--keep");
  return flags;
}

function single(flag: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${flag} takes one value, given once.`);
  }
  return value;
}

function pair(flag: string, values: readonly string[]): [string, string] {
  if (values.length !== 2 || values.some((v) => typeof v !== "string")) {
    throw new Error(`${flag} takes exactly two values: ${flag} <id> <${flag === "--rename" ? "new value" : "alias"}>.`);
  }
  return [values[0]!, values[1]!];
}

/** The one invariant action the flags name; a refusal when there is not exactly one. */
function invariantAction(input: CatalogResolveInput): InvariantAction {
  const actions: InvariantAction[] = [];
  if (input.rename !== undefined) {
    const [id, value] = pair("--rename", input.rename);
    actions.push({ kind: "rename", id, value });
  }
  if (input.dropAlias !== undefined) {
    const [id, alias] = pair("--drop-alias", input.dropAlias);
    actions.push({ kind: "drop-alias", id, alias });
  }
  const keep = single("--keep", input.keep);
  if (keep !== undefined) actions.push({ kind: "keep", id: keep });
  if (actions.length !== 1) {
    throw new Error("--invariant <n> takes exactly one of --rename <id> <value>, --drop-alias <id> <alias> or --keep <id>.");
  }
  return actions[0]!;
}

function checkFlags(input: CatalogResolveInput): void {
  const actionFlags = [input.rename, input.dropAlias, input.keep].filter((v) => v !== undefined).length;
  if (input.invariant !== undefined) {
    if (input.use !== undefined || input.value !== undefined || input.field !== undefined || input.group !== undefined || input.entityId !== undefined) {
      throw new Error("--invariant <n> is resolved by changing entries: it takes --rename, --drop-alias or --keep, not --use, --value, --field, --group or --id.");
    }
    return;
  }
  if (actionFlags > 0) {
    throw new Error("--rename, --drop-alias and --keep resolve an invariant conflict: name it with --invariant <n>.");
  }
}

/** Thrown out of the transaction when the file has no records: nothing is written. */
class NothingToResolve extends Error {}

function safe(line: string, max = MAX_PROSE_LENGTH): string {
  return sanitizeDisplayText(line, max);
}

export async function handleCatalogResolve(
  type: CatalogConflictType,
  root: string,
  input: CatalogResolveInput,
): Promise<CommandResult> {
  const format = input.format ?? "md";
  const file = CATALOG_CONFLICT_IDS[type];
  const isCapabilities = type === "capabilities";
  const key: CatalogKey = isCapabilities ? "capabilities" : "terms";

  const guardDelete = (entryId: string): void => {
    if (isCapabilities) {
      throw new Error(
        `Cannot resolve: the chosen side deletes capability "${entryId}", and a resolution never deletes a capability. ` +
        `Choose the other side; remove it afterwards with the capability commands if it should go.`,
      );
    }
    const refusal = termDeletionRefusal(entryId, root);
    if (refusal !== null) throw new Error(`Cannot delete term "${entryId}" in this resolution: ${refusal}`);
  };

  let result!: ResolveResult;
  try {
    checkFlags(input);
    const entityId = single("--id", input.entityId);
    const group = single("--group", input.group);
    const action = input.invariant !== undefined ? invariantAction(input) : undefined;
    const fn = (current: unknown): never => {
      const doc = structuredClone(current) as Record<string, unknown>;
      // A clean (or absent) catalog is not rewritten: the write would create
      // a file that was not there, for nothing.
      if (!Array.isArray(doc._conflicts) || doc._conflicts.length === 0) throw new NothingToResolve();
      if (action !== undefined) {
        result = resolveCatalogInvariant(doc, input.invariant!, action, {
          file,
          key,
          guardDelete,
          now: () => new Date().toISOString(),
        });
        return doc as never;
      }
      const before = catalogViolations(doc, key);
      const applied = resolveCatalogConflicts(
        doc,
        { field: input.field, use: input.use, value: input.value, entityId, group },
        { file, key, groups: getCoupledGroups(isCapabilities ? "capability" : "term"), guardDelete },
      );
      const after = catalogViolations(doc, key);
      assertNoNewCollision(before, after, file);
      const synced = syncInvariantRecords((doc._conflicts as ConflictEntry[] | undefined) ?? [], after);
      if (synced.conflicts.length === 0) delete doc._conflicts;
      else doc._conflicts = synced.conflicts;
      const messages = [...applied.messages];
      for (const c of synced.narrowed) {
        messages.push(`Invariant ${JSON.stringify(c.key)} narrowed, ${(c.entityIds ?? []).length} claimants remain: ${(c.entityIds ?? []).join(", ")}.`);
      }
      if (synced.consumed.length > 0) {
        messages.push(`${synced.consumed.length} invariant record(s) no longer describe a collision and were cleared.`);
      }
      result = {
        ...applied,
        messages,
        remaining: synced.conflicts.length,
        fullyResolved: synced.conflicts.length === 0,
      };
      return doc as never;
    };
    if (isCapabilities) await capabilityCatalog.mutateForRepair(root, fn);
    else await glossaryCatalog.mutateForRepair(root, fn);
  } catch (err) {
    if (err instanceof NothingToResolve) {
      if (format === "json") {
        const clean: ResolveResult = { resolved: [], remaining: 0, fullyResolved: true, warnings: [], messages: [] };
        return { output: JSON.stringify({ ok: true, data: clean }, null, 2) };
      }
      return { output: `${file} has no conflicts.` };
    }
    // Messages carry ids and values read from a merged file: made safe to print.
    throw new Error(safe(err instanceof Error ? err.message : String(err)));
  }

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: result }, null, 2) };
  }
  const lines = [`Resolved ${result.resolved.length} conflict(s) on ${file}.`];
  lines.push(...result.messages, ...result.warnings);
  lines.push(result.remaining > 0 ? `${result.remaining} conflict(s) remaining.` : "All conflicts resolved.");
  return { output: lines.map((l) => safe(l)).join("\n") };
}
