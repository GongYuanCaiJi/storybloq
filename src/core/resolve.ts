import type { ConflictEntry } from "../models/types.js";

export interface ResolveOptions {
  field?: string;
  use?: "ours" | "theirs";
  value?: unknown;
  /** Actor for synthesized attribution (legacy tombstone recovery). */
  actor?: string;
}

export interface ResolveResult {
  resolved: string[];
  remaining: number;
  fullyResolved: boolean;
  /** Advisory messages (e.g. best-effort attribution notes), printed verbatim. */
  warnings: string[];
  /** What happened, for entity-level resolutions (printed on success). */
  messages: string[];
}

export function fieldName(c: ConflictEntry): string {
  return (c as Record<string, unknown>).field as string | undefined
    ?? c.fieldPath.replace(/^\//, "");
}

export function matchesField(c: ConflictEntry, input: string): boolean {
  if (c.fieldPath === input) return true;
  const plain = input.replace(/^\//, "");
  if (c.fieldPath === `/${plain}`) return true;
  if ((c as Record<string, unknown>).field === plain) return true;
  return false;
}

/**
 * Entity-level (whole entity) conflict entries: the delete-vs-edit snapshots
 * written by the merge driver (kind "delete-edit") and the validation
 * fallback's whole-entity entries (kind "field"). Recognition never keys on
 * `kind` -- the enum is closed and both kinds are semantically whole-entity.
 */
export function isEntityLevel(c: ConflictEntry): boolean {
  return (c as Record<string, unknown>).field === "_entity" || c.fieldPath === "";
}

function isDeletedSnapshot(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || (obj.deletedAt != null && obj.deletedAt !== undefined);
}

function otherSide(side: "ours" | "theirs" | undefined): "ours" | "theirs" {
  return side === "ours" ? "theirs" : "ours";
}

/** Wholesale replacement of the entity body with a full-entity object. */
function replaceEntityBody(entity: Record<string, unknown>, chosen: Record<string, unknown>): void {
  for (const k of Object.keys(entity)) {
    if (k !== "_conflicts") delete entity[k];
  }
  for (const [k, v] of Object.entries(chosen)) {
    if (k !== "_conflicts") entity[k] = v;
  }
}

/**
 * Applies one entity-level entry. Returns a human-readable message describing
 * what happened. Throws (leaving the entity body untouched by this entry) when
 * the chosen content is unrecoverable.
 */
function applyEntityLevel(
  entity: Record<string, unknown>,
  c: ConflictEntry,
  options: ResolveOptions,
  warnings: string[],
): string {
  if (options.value !== undefined) {
    const value = options.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `Entity-level conflicts take a full entity object via --value '<full entity JSON>'.`,
      );
    }
    const chosen = value as Record<string, unknown>;
    if (chosen.id !== undefined && entity.id !== undefined && chosen.id !== entity.id) {
      throw new Error(
        `--value id "${String(chosen.id)}" does not match entity id "${String(entity.id)}".`,
      );
    }
    replaceEntityBody(entity, chosen);
    return "Applied custom entity value.";
  }

  const side = options.use!;
  const chosen = side === "ours" ? c.ours : c.theirs;

  // Legacy placeholder entries written by storybloq < 1.5.0 record only
  // "deleted"/"edited" strings -- the actual content was never captured.
  if (typeof chosen === "string") {
    if (chosen === "deleted") {
      entity.lifecycle = "deleted";
      if (entity.deletedAt == null) entity.deletedAt = new Date().toISOString();
      entity.deletedBy = options.actor ?? "unknown";
      warnings.push(
        `Attribution on the synthesized tombstone is best-effort: the original delete stamp was never recorded by the pre-1.5.0 driver.`,
      );
      return `Applied delete (tombstone) from ${side}.`;
    }
    throw new Error(
      `This delete-edit conflict was recorded by storybloq < 1.5.0 and does not contain the edited content. ` +
      `Recover it with: git log --all -p -- .story/<dir>/<id>.json, then apply it with: ` +
      `storybloq resolve <id> --value '<full entity JSON>' -- or choose the delete side with --use ${otherSide(side)}.`,
    );
  }

  // R3: a side with no recoverable content must fail loudly, never write
  // null/undefined/{} into the entity body.
  if (
    chosen === null || chosen === undefined ||
    (typeof chosen === "object" && !Array.isArray(chosen) && Object.keys(chosen as Record<string, unknown>).length === 0)
  ) {
    throw new Error(
      `Side "${side}" of this conflict has no recoverable content; use --use ${otherSide(side)} ` +
      `or resolve by hand with --value '<full entity JSON>'.`,
    );
  }
  if (typeof chosen !== "object" || Array.isArray(chosen)) {
    throw new Error(
      `Side "${side}" of this conflict is not an entity snapshot; resolve with --value '<full entity JSON>'.`,
    );
  }

  const snapshot = chosen as Record<string, unknown>;
  if (snapshot.id !== undefined && entity.id !== undefined && snapshot.id !== entity.id) {
    throw new Error(
      `Snapshot id "${String(snapshot.id)}" does not match entity id "${String(entity.id)}".`,
    );
  }
  replaceEntityBody(entity, snapshot);
  return isDeletedSnapshot(snapshot)
    ? `Applied delete (tombstone) from ${side}.`
    : `Restored edited entity from ${side}.`;
}

export function resolveConflicts(
  entity: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const conflicts = entity._conflicts as ConflictEntry[] | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { resolved: [], remaining: 0, fullyResolved: true, warnings: [], messages: [] };
  }

  const resolved: string[] = [];
  const remaining: ConflictEntry[] = [];
  const warnings: string[] = [];
  const messages: string[] = [];

  if (options.field) {
    const target = conflicts.find((c) => matchesField(c, options.field!));
    if (!target) {
      throw new Error(`No conflict found for field "${options.field}"`);
    }

    if (target.kind === "coupled" && target.group) {
      if (options.value !== undefined) {
        throw new Error(`Cannot use --value on coupled group field "${options.field}". Use --use ours|theirs to resolve coupled groups.`);
      }
      const side = options.use;
      if (!side) {
        throw new Error(`Coupled group field "${options.field}" requires --use ours|theirs.`);
      }
      for (const c of conflicts) {
        if (c.kind === "coupled" && c.group === target.group) {
          const name = fieldName(c);
          entity[name] = side === "ours" ? c.ours : c.theirs;
          resolved.push(name);
        } else {
          remaining.push(c);
        }
      }
    } else {
      // ISS-758: without an explicit choice the old code silently applied
      // theirs. Require the user to pick a side or supply a value.
      if (options.value === undefined && !options.use) {
        throw new Error(
          `--field "${options.field}" requires --use ours|theirs or --value. ` +
          `Example: storybloq resolve <id> --field ${options.field} --use theirs`,
        );
      }
      if (isEntityLevel(target)) {
        messages.push(applyEntityLevel(entity, target, options, warnings));
        resolved.push("_entity");
      } else {
        const name = fieldName(target);
        const value = options.value !== undefined
          ? options.value
          : options.use === "ours" ? target.ours : target.theirs;
        entity[name] = value;
        resolved.push(name);
      }
      for (const c of conflicts) {
        if (c !== target) remaining.push(c);
      }
    }
  } else if (options.use) {
    const side = options.use;
    // Entity-level entries are applied FIRST (wholesale body replacement),
    // then field-level entries land on the replaced body.
    const entityLevel = conflicts.filter((c) => isEntityLevel(c));
    const fieldLevel = conflicts.filter((c) => !isEntityLevel(c));
    for (const c of entityLevel) {
      // Blanket application always uses the side; --value only applies to a
      // --field-targeted entry.
      messages.push(applyEntityLevel(entity, c, { use: side, actor: options.actor }, warnings));
      resolved.push("_entity");
    }
    for (const c of fieldLevel) {
      const name = fieldName(c);
      entity[name] = side === "ours" ? c.ours : c.theirs;
      resolved.push(name);
    }
  } else {
    throw new Error("Must specify --use or --field");
  }

  if (remaining.length === 0) {
    delete entity._conflicts;
  } else {
    entity._conflicts = remaining;
  }

  return {
    resolved,
    remaining: remaining.length,
    fullyResolved: remaining.length === 0,
    warnings,
    messages,
  };
}
