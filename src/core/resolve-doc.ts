import type { ConflictEntry } from "../models/types.js";
import { fieldName, matchesField, isEntityLevel, type ResolveOptions, type ResolveResult } from "./resolve.js";

/**
 * Conflict resolution for config.json / roadmap.json (ISS-749).
 *
 * Unlike entity resolution (top-level fields only), document conflicts carry
 * nested JSON-Pointer fieldPaths, keyed-array element aliases
 * (e.g. "phases[id=p2]") and id-order reorder entries. Application is by
 * location, never by blind top-level assignment.
 */

const KEYED_ALIAS_REGEX = /^(.+)\[([^=\]]+)=(.+)\]$/;

/** RFC 6901 pointer segments; a legacy bare fieldPath is one top-level segment. */
function parsePointer(fieldPath: string): string[] {
  if (!fieldPath.startsWith("/")) return [fieldPath];
  return fieldPath
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerError(fieldPath: string): Error {
  return new Error(
    `Cannot apply conflict resolution at "${fieldPath}": the container is missing or the index is out of range ` +
    `(the document may have been hand-edited since the merge). Resolve by hand and re-run, or use --value.`,
  );
}

/** Walks to the parent container of the pointer's final segment. */
function containerAt(doc: Record<string, unknown>, segments: string[], fieldPath: string): Record<string, unknown> | unknown[] {
  let current: unknown = doc;
  for (const seg of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) throw pointerError(fieldPath);
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      throw pointerError(fieldPath);
    }
  }
  if (Array.isArray(current)) return current;
  if (typeof current === "object" && current !== null) return current as Record<string, unknown>;
  throw pointerError(fieldPath);
}

/**
 * Sets (or, for `chosen === undefined`, deletes) the value at an RFC 6901
 * pointer. Missing containers and out-of-range indices fail loudly.
 */
function applyAtPointer(doc: Record<string, unknown>, fieldPath: string, chosen: unknown): void {
  const segments = parsePointer(fieldPath);
  if (segments.length === 0) throw pointerError(fieldPath);
  const container = containerAt(doc, segments, fieldPath);
  const last = segments[segments.length - 1]!;

  if (Array.isArray(container)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= container.length) throw pointerError(fieldPath);
    if (chosen === undefined) {
      container.splice(idx, 1);
    } else {
      container[idx] = chosen;
    }
    return;
  }

  if (chosen === undefined) {
    delete container[last];
  } else {
    container[last] = chosen;
  }
}

interface KeyedTarget {
  arr: unknown[];
  keyField: string;
  keyValue: string;
  recordedIndex: number;
}

function keyedTarget(doc: Record<string, unknown>, c: ConflictEntry): KeyedTarget {
  const alias = fieldName(c);
  const match = KEYED_ALIAS_REGEX.exec(alias)!;
  const [, , keyField, keyValue] = match;
  const segments = parsePointer(c.fieldPath);
  const recordedIndex = Number(segments[segments.length - 1]);
  const containerSegments = segments.slice(0, -1);
  let current: unknown = doc;
  for (const seg of containerSegments) {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else if (Array.isArray(current)) {
      current = current[Number(seg)];
    } else {
      throw pointerError(c.fieldPath);
    }
  }
  if (!Array.isArray(current)) throw pointerError(c.fieldPath);
  return { arr: current, keyField: keyField!, keyValue: keyValue!, recordedIndex: Number.isInteger(recordedIndex) ? recordedIndex : 0 };
}

/** Locates an element by key (robust to index drift); -1 when absent. */
function keyedIndexOf(target: KeyedTarget): number {
  return target.arr.findIndex(
    (el) => typeof el === "object" && el !== null && (el as Record<string, unknown>)[target.keyField] === target.keyValue,
  );
}

function applyKeyedElement(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown): void {
  const target = keyedTarget(doc, c);
  const idx = keyedIndexOf(target);

  if (chosen === undefined) {
    // Chosen side deleted the element.
    if (idx >= 0) target.arr.splice(idx, 1);
    return;
  }

  if (typeof chosen !== "object" || chosen === null) {
    throw new Error(
      `Conflict "${fieldName(c)}": the chosen side is not an element object. Resolve with --value '<element JSON>'.`,
    );
  }

  if (idx >= 0) {
    target.arr[idx] = chosen;
    return;
  }
  if (c.kind === "delete-edit") {
    // Element missing (already removed): restore at the recorded index, clamped.
    const insertAt = Math.max(0, Math.min(target.recordedIndex, target.arr.length));
    target.arr.splice(insertAt, 0, chosen);
    return;
  }
  throw new Error(
    `Conflict "${fieldName(c)}": no element with ${target.keyField}="${target.keyValue}" exists in the document ` +
    `(hand-edited since the merge?). Resolve by hand and re-run, or use --value.`,
  );
}

/**
 * Reorder entries record id-string arrays for each side (the keyed-array
 * order conflict). Application reorders the EXISTING merged elements --
 * preserving their cleanly merged content, never replacing elements -- to the
 * chosen side's id order. Elements in the doc missing from the chosen order
 * append at the end in current relative order; ids in the order missing from
 * the doc are skipped.
 */
function isReorderEntry(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown): boolean {
  if (!Array.isArray(chosen) || !chosen.every((v) => typeof v === "string")) return false;
  const segments = parsePointer(c.fieldPath);
  let current: unknown = doc;
  for (const seg of segments) {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return Array.isArray(current) && current.length > 0 &&
    current.every((el) => typeof el === "object" && el !== null);
}

function applyReorder(doc: Record<string, unknown>, c: ConflictEntry, chosenOrder: string[]): void {
  const segments = parsePointer(c.fieldPath);
  let parent: Record<string, unknown> = doc;
  for (const seg of segments.slice(0, -1)) {
    parent = parent[seg] as Record<string, unknown>;
  }
  const key = segments[segments.length - 1]!;
  const arr = parent[key] as Array<Record<string, unknown>>;

  const keyField = arr.every((el) => typeof el.id === "string") ? "id"
    : arr.every((el) => typeof el.name === "string") ? "name"
    : null;
  if (!keyField) {
    throw new Error(
      `Cannot reorder "${c.fieldPath}": elements have no common string "id" or "name" key. Resolve by hand.`,
    );
  }

  const byKey = new Map(arr.map((el) => [el[keyField] as string, el]));
  const result: Array<Record<string, unknown>> = [];
  const placed = new Set<string>();
  for (const id of chosenOrder) {
    const el = byKey.get(id);
    if (el) {
      result.push(el);
      placed.add(id);
    }
    // ids missing from the doc are skipped
  }
  for (const el of arr) {
    const k = el[keyField] as string;
    if (!placed.has(k)) result.push(el); // doc-only elements append in current relative order
  }
  parent[key] = result;
}

type PlannedOp =
  | { op: "entity"; c: ConflictEntry; chosen: unknown }
  | { op: "reorder"; c: ConflictEntry; chosen: string[] }
  | { op: "keyed"; c: ConflictEntry; chosen: unknown }
  | { op: "pointer-set"; c: ConflictEntry; chosen: unknown }
  | { op: "pointer-delete"; c: ConflictEntry };

function planOp(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown): PlannedOp {
  if (isEntityLevel(c)) return { op: "entity", c, chosen };
  if (KEYED_ALIAS_REGEX.test(fieldName(c))) return { op: "keyed", c, chosen };
  if (isReorderEntry(doc, c, chosen)) return { op: "reorder", c, chosen: chosen as string[] };
  if (chosen === undefined) return { op: "pointer-delete", c };
  return { op: "pointer-set", c, chosen };
}

function applyEntityLevelDoc(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown, side: "ours" | "theirs" | undefined): void {
  if (
    chosen === null || chosen === undefined || typeof chosen !== "object" || Array.isArray(chosen) ||
    Object.keys(chosen as Record<string, unknown>).length === 0
  ) {
    throw new Error(
      `Side "${side ?? "value"}" of this conflict has no recoverable content; ` +
      `use --use ${side === "ours" ? "theirs" : "ours"} or resolve by hand with --value '<full document JSON>'.`,
    );
  }
  for (const k of Object.keys(doc)) {
    if (k !== "_conflicts") delete doc[k];
  }
  for (const [k, v] of Object.entries(chosen as Record<string, unknown>)) {
    if (k !== "_conflicts") doc[k] = v;
  }
}

/** Descending recorded index, so earlier splices never shift later targets. */
function pointerDeleteIndex(c: ConflictEntry): number {
  const segments = parsePointer(c.fieldPath);
  const idx = Number(segments[segments.length - 1]);
  return Number.isInteger(idx) ? idx : -1;
}

function applyPlanned(doc: Record<string, unknown>, ops: PlannedOp[], side: "ours" | "theirs" | undefined): void {
  // Bulk application order: entity-level first; then reorder; then
  // keyed-element operations (key lookup makes them index-immune); then
  // pointer sets; pointer-index DELETIONS last, in descending index order per
  // array so recorded indices stay valid.
  const order: Array<PlannedOp["op"]> = ["entity", "reorder", "keyed", "pointer-set", "pointer-delete"];
  for (const stage of order) {
    let staged = ops.filter((o) => o.op === stage);
    if (stage === "pointer-delete") {
      staged = [...staged].sort((a, b) => pointerDeleteIndex(b.c) - pointerDeleteIndex(a.c));
    }
    for (const op of staged) {
      switch (op.op) {
        case "entity": applyEntityLevelDoc(doc, op.c, op.chosen, side); break;
        case "reorder": applyReorder(doc, op.c, op.chosen); break;
        case "keyed": applyKeyedElement(doc, op.c, op.chosen); break;
        case "pointer-set": applyAtPointer(doc, op.c.fieldPath, op.chosen); break;
        case "pointer-delete": applyAtPointer(doc, op.c.fieldPath, undefined); break;
      }
    }
  }
}

export function resolveDocConflicts(
  doc: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const conflicts = doc._conflicts as ConflictEntry[] | undefined;
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
    // ISS-758 guard: an explicit choice is required.
    if (options.value === undefined && !options.use) {
      throw new Error(
        `--field "${options.field}" requires --use ours|theirs or --value. ` +
        `Example: storybloq resolve <id> --field ${options.field} --use theirs`,
      );
    }
    const hasValue = options.value !== undefined;
    const chosen = hasValue
      ? options.value
      : options.use === "ours" ? target.ours : target.theirs;
    applyPlanned(doc, [planOp(doc, target, chosen)], options.use);
    resolved.push(fieldName(target) || "_entity");
    for (const c of conflicts) {
      if (c !== target) remaining.push(c);
    }
  } else if (options.use) {
    const side = options.use;
    const ops = conflicts.map((c) => planOp(doc, c, side === "ours" ? c.ours : c.theirs));
    applyPlanned(doc, ops, side);
    for (const c of conflicts) {
      resolved.push(fieldName(c) || "_entity");
    }
  } else {
    throw new Error("Must specify --use or --field");
  }

  if (remaining.length === 0) {
    delete doc._conflicts;
  } else {
    doc._conflicts = remaining;
  }

  return {
    resolved,
    remaining: remaining.length,
    fullyResolved: remaining.length === 0,
    warnings,
    messages,
  };
}
