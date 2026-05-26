import type { ConflictEntry } from "../models/types.js";

export interface ResolveOptions {
  field?: string;
  use?: "ours" | "theirs";
  value?: unknown;
}

export interface ResolveResult {
  resolved: string[];
  remaining: number;
  fullyResolved: boolean;
}

export function resolveConflicts(
  entity: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const conflicts = entity._conflicts as ConflictEntry[] | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { resolved: [], remaining: 0, fullyResolved: true };
  }

  const resolved: string[] = [];
  const remaining: ConflictEntry[] = [];

  if (options.field) {
    const target = conflicts.find((c) => c.fieldPath === options.field);
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
          entity[c.fieldPath] = side === "ours" ? c.ours : c.theirs;
          resolved.push(c.fieldPath);
        } else {
          remaining.push(c);
        }
      }
    } else {
      const value = options.value !== undefined
        ? options.value
        : options.use === "ours" ? target.ours : target.theirs;
      entity[target.fieldPath] = value;
      resolved.push(target.fieldPath);
      for (const c of conflicts) {
        if (c.fieldPath !== target.fieldPath) remaining.push(c);
      }
    }
  } else if (options.use) {
    const side = options.use;
    for (const c of conflicts) {
      entity[c.fieldPath] = side === "ours" ? c.ours : c.theirs;
      resolved.push(c.fieldPath);
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
  };
}
