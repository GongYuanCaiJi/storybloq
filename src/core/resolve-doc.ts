import type { ConflictEntry } from "../models/types.js";
import { fieldName, matchesField, isEntityLevel, type ResolveOptions, type ResolveResult } from "./resolve.js";

/**
 * Conflict resolution for config.json / roadmap.json (ISS-749).
 *
 * Unlike entity resolution (top-level fields only), document conflicts carry
 * nested JSON-Pointer fieldPaths, keyed-array element aliases
 * (e.g. "phases[id=p2]") and id-order reorder entries. Application is by
 * location, never by blind top-level assignment.
 *
 * Two hardening layers (ISS-768/ISS-769) shape everything below. _conflicts
 * entries arrive from merges of teammate branches and are UNTRUSTED input:
 * (1) pointer segments never traverse prototype keys (ISS-768), and
 * (2) pointer fieldPaths carry MERGE-TIME array indices, so pointer ops are
 *     captured against the pre-mutation document and applied afterwards by
 *     element identity; every ambiguity refuses loudly instead of guessing
 *     (ISS-769).
 */

const KEYED_ALIAS_REGEX = /^(.+)\[([^=\]]+)=(.+)\]$/;

/** ISS-768: segments that would walk or write the prototype chain. */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 6901 pointer segments; a legacy bare fieldPath is one top-level segment. */
function parsePointer(fieldPath: string): string[] {
  const segments = !fieldPath.startsWith("/")
    ? [fieldPath]
    : fieldPath
        .slice(1)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  // ISS-768: exact segment equality only, applied AFTER ~-unescaping, so
  // benign fields like "prototypeSettings" are untouched.
  for (const seg of segments) {
    if (RESERVED_SEGMENTS.has(seg)) {
      throw new Error(
        `Cannot apply conflict resolution at "${fieldPath}": pointer segment "${seg}" is a reserved prototype key ` +
        `(_conflicts entries are untrusted input and never traverse prototypes). Resolve by hand and re-run, or use --value.`,
      );
    }
  }
  return segments;
}

function pointerError(fieldPath: string): Error {
  return new Error(
    `Cannot apply conflict resolution at "${fieldPath}": the container is missing or the index is out of range ` +
    `(the document may have been hand-edited since the merge). Resolve by hand and re-run, or use --value.`,
  );
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

/**
 * Same-batch mutation bookkeeping (ISS-769): keyed replacements and pointer
 * sets record old-element -> new-value edges; keyed deletes and pointer
 * deletes record removals. Only object nodes are recorded: primitives have no
 * identity, so value-keyed entries would alias unrelated equal values.
 */
interface ApplyBook {
  removed: Set<unknown>;
  replaced: Map<unknown, unknown>;
}

function applyKeyedElement(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown, book: ApplyBook): void {
  const target = keyedTarget(doc, c);
  const idx = keyedIndexOf(target);

  if (chosen === undefined) {
    // Chosen side deleted the element.
    if (idx >= 0) {
      const old = target.arr[idx];
      if (typeof old === "object" && old !== null) book.removed.add(old);
      target.arr.splice(idx, 1);
    }
    return;
  }

  if (typeof chosen !== "object" || chosen === null) {
    throw new Error(
      `Conflict "${fieldName(c)}": the chosen side is not an element object. Resolve with --value '<element JSON>'.`,
    );
  }

  if (idx >= 0) {
    const old = target.arr[idx];
    if (typeof old === "object" && old !== null) book.replaced.set(old, chosen);
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

  const original = [...arr];
  const byKey = new Map(original.map((el) => [el[keyField] as string, el]));
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
  for (const el of original) {
    const k = el[keyField] as string;
    if (!placed.has(k)) result.push(el); // doc-only elements append in current relative order
  }
  // IN PLACE, element references preserved: captured pointer targets (ISS-769)
  // must keep pointing at this same array object across the reorder. No spread
  // (argument-limit safe on large arrays); reorder never removes elements, so
  // it contributes nothing to the ApplyBook.
  arr.length = 0;
  for (const el of result) arr.push(el);
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

/**
 * ISS-769 capture/apply machinery. Pointer ops are captured against the
 * post-entity, pre-reorder/keyed document (where merge-time indices are still
 * valid), binding each numeric segment to the element it referenced. They are
 * applied after array mutation by re-walking from the root with identity
 * lookups. Refusal ladder on every ambiguity: never guess, never write to a
 * detached node, never mark a conflict resolved on a write that did not land.
 */
type CapturedStep =
  | { kind: "key"; seg: string; node: unknown }
  | { kind: "index"; seg: number; elem: unknown; keyed?: { keyField: string; keyValue: string } | "ambiguous"; keyedOpsPresent: boolean };

interface CapturedPointerOp {
  op: "pointer-set" | "pointer-delete";
  fieldPath: string;
  chosen?: unknown;
  steps: CapturedStep[];
}

/** Keyed-op aliases per array pointer path (defense in depth for relocation). */
function keyedMetaByArrayPath(ops: PlannedOp[]): Map<string, Array<{ keyField: string; keyValue: string }>> {
  const map = new Map<string, Array<{ keyField: string; keyValue: string }>>();
  for (const op of ops) {
    if (op.op !== "keyed") continue;
    const match = KEYED_ALIAS_REGEX.exec(fieldName(op.c));
    if (!match) continue;
    const segments = parsePointer(op.c.fieldPath);
    const key = JSON.stringify(segments.slice(0, -1));
    const list = map.get(key) ?? [];
    list.push({ keyField: match[2]!, keyValue: match[3]! });
    map.set(key, list);
  }
  return map;
}

function capturePointerOp(
  doc: Record<string, unknown>,
  op: "pointer-set" | "pointer-delete",
  c: ConflictEntry,
  chosen: unknown,
  keyedMeta: Map<string, Array<{ keyField: string; keyValue: string }>>,
): CapturedPointerOp {
  const fieldPath = c.fieldPath;
  const segments = parsePointer(fieldPath);
  if (segments.length === 0) throw pointerError(fieldPath);
  const steps: CapturedStep[] = [];
  let current: unknown = doc;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isFinal = i === segments.length - 1;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) throw pointerError(fieldPath);
      const elem: unknown = current[idx];
      const entries = keyedMeta.get(JSON.stringify(segments.slice(0, i))) ?? [];
      const matched = new Map<string, { keyField: string; keyValue: string }>();
      if (typeof elem === "object" && elem !== null) {
        for (const e of entries) {
          if ((elem as Record<string, unknown>)[e.keyField] === e.keyValue) {
            matched.set(`${e.keyField}=${e.keyValue}`, e);
          }
        }
      }
      const step: CapturedStep = { kind: "index", seg: idx, elem, keyedOpsPresent: entries.length > 0 };
      if (matched.size === 1) step.keyed = [...matched.values()][0];
      else if (matched.size > 1) step.keyed = "ambiguous";
      steps.push(step);
      current = elem;
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      // Mid-walk segments must be OWN properties (ISS-768 defense in depth);
      // the final segment may be a new key (set) or absent (delete no-op).
      if (!isFinal && !Object.hasOwn(obj, seg)) throw pointerError(fieldPath);
      steps.push({ kind: "key", seg, node: obj[seg] });
      current = obj[seg];
    } else {
      throw pointerError(fieldPath);
    }
  }
  return { op, fieldPath, chosen, steps };
}

/** Whole-array scan requiring at most one === match; -2 signals ambiguity. */
function locateUnique(arr: unknown[], value: unknown): number {
  let found = -1;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === value) {
      count += 1;
      if (found < 0) found = i;
    }
  }
  return count > 1 ? -2 : found;
}

/** Unique lookup by key field; more than one match refuses. */
function uniqueIndexByField(arr: unknown[], field: string, value: unknown, fieldPath: string): number {
  let found = -1;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (typeof el === "object" && el !== null && (el as Record<string, unknown>)[field] === value) {
      count += 1;
      if (found < 0) found = i;
    }
  }
  if (count > 1) throw pointerError(fieldPath);
  return found;
}

/** Follows same-batch replacement edges; a cycle (crafted input) refuses. */
function chainHead(replaced: Map<unknown, unknown>, start: unknown, fieldPath: string): unknown {
  const seen = new Set<unknown>([start]);
  let cur = start;
  while (replaced.has(cur)) {
    cur = replaced.get(cur);
    if (seen.has(cur)) throw pointerError(fieldPath);
    seen.add(cur);
  }
  return cur;
}

type Located = { idx: number; node: unknown; moved: boolean } | "gone";

/**
 * Resolves a captured index step against the CURRENT array. Ladder:
 * (1) reference identity (aliased duplicates refuse);
 * (2) same-batch replacement chain (cycle-guarded);
 * (3) keyed metadata recorded at capture (ambiguity marker refuses);
 * (4) id/name heuristic, only when the array had no keyed ops in the batch;
 * (5) a FINAL delete whose element was genuinely removed reports "gone";
 * (6) otherwise refuse.
 */
function locateElement(arr: unknown[], step: Extract<CapturedStep, { kind: "index" }>, book: ApplyBook, fieldPath: string, forFinalDelete: boolean): Located {
  const elem = step.elem;
  // Primitive elements have no identity: apply at the recorded index guarded
  // by a value check. Primitive arrays are unreachable by reorder/keyed stages
  // (both require object elements), so a mismatch means same-batch sibling
  // drift: refuse rather than guess (duplicates make indexOf wrong).
  if (typeof elem !== "object" || elem === null) {
    if (step.seg < arr.length && arr[step.seg] === elem) return { idx: step.seg, node: elem, moved: false };
    throw pointerError(fieldPath);
  }
  let idx = locateUnique(arr, elem);
  if (idx === -2) throw pointerError(fieldPath);
  if (idx >= 0) return { idx, node: elem, moved: false };
  const head = chainHead(book.replaced, elem, fieldPath);
  if (head !== elem) {
    idx = locateUnique(arr, head);
    if (idx === -2) throw pointerError(fieldPath);
    if (idx >= 0) return { idx, node: head, moved: true };
  }
  if (step.keyed === "ambiguous") throw pointerError(fieldPath);
  if (step.keyed) {
    idx = uniqueIndexByField(arr, step.keyed.keyField, step.keyed.keyValue, fieldPath);
    if (idx >= 0) return { idx, node: arr[idx], moved: true };
  }
  if (!step.keyedOpsPresent) {
    const el = elem as Record<string, unknown>;
    const hkey = typeof el.id === "string" ? "id" : typeof el.name === "string" ? "name" : null;
    if (hkey) {
      idx = uniqueIndexByField(arr, hkey, el[hkey], fieldPath);
      if (idx >= 0) return { idx, node: arr[idx], moved: true };
    }
  }
  if (forFinalDelete && (book.removed.has(elem) || book.removed.has(head))) return "gone";
  throw pointerError(fieldPath);
}

function applyCapturedOp(doc: Record<string, unknown>, cap: CapturedPointerOp, book: ApplyBook): void {
  let current: unknown = doc;
  let moved = false;
  const steps = cap.steps;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]!;
    if (step.kind === "index") {
      if (!Array.isArray(current)) throw pointerError(cap.fieldPath);
      const located = locateElement(current, step, book, cap.fieldPath, false) as Exclude<Located, "gone">;
      moved = moved || located.moved;
      current = located.node;
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) throw pointerError(cap.fieldPath);
      const obj = current as Record<string, unknown>;
      if (!Object.hasOwn(obj, step.seg)) throw pointerError(cap.fieldPath);
      const next = obj[step.seg];
      // Outside a relocated subtree the reached node must BE the captured one:
      // a mismatch means an unrelated same-batch op swapped this ancestor
      // (untrusted overlap); refuse rather than write into the swap. Inside a
      // relocated subtree (the user's chosen replacement) keys are followed
      // by name; that subtree is legitimately different.
      if (!moved && next !== step.node) throw pointerError(cap.fieldPath);
      current = next;
    }
  }
  const last = steps[steps.length - 1]!;
  if (last.kind === "index") {
    if (!Array.isArray(current)) throw pointerError(cap.fieldPath);
    const arr = current;
    if (cap.op === "pointer-set") {
      const located = locateElement(arr, last, book, cap.fieldPath, false) as Exclude<Located, "gone">;
      // Aliasing guard: a chosen OBJECT already present elsewhere in this
      // array would poison every later identity lookup in the batch.
      // Primitive chosen values are legitimate duplicate content.
      if (typeof cap.chosen === "object" && cap.chosen !== null) {
        const j = locateUnique(arr, cap.chosen);
        if (j === -2 || (j >= 0 && j !== located.idx)) throw pointerError(cap.fieldPath);
      }
      arr[located.idx] = cap.chosen;
      if (typeof located.node === "object" && located.node !== null) book.replaced.set(located.node, cap.chosen);
    } else {
      const located = locateElement(arr, last, book, cap.fieldPath, true);
      if (located === "gone") return;
      arr.splice(located.idx, 1);
      if (typeof located.node === "object" && located.node !== null) book.removed.add(located.node);
    }
  } else {
    if (typeof current !== "object" || current === null || Array.isArray(current)) throw pointerError(cap.fieldPath);
    const obj = current as Record<string, unknown>;
    if (cap.op === "pointer-set") {
      obj[last.seg] = cap.chosen;
    } else {
      delete obj[last.seg];
    }
  }
}

/** Descending recorded index, so earlier splices never shift later targets. */
function capturedDeleteIndex(cap: CapturedPointerOp): number {
  const last = cap.steps[cap.steps.length - 1]!;
  return last.kind === "index" ? last.seg : -1;
}

function applyPlanned(doc: Record<string, unknown>, ops: PlannedOp[], side: "ours" | "theirs" | undefined): void {
  // Bulk application order (ISS-769): entity-level first; pointer ops are then
  // CAPTURED while merge-time indices are still valid; reorder (in-place) and
  // keyed stages mutate array shape; captured sets apply by element identity;
  // captured pointer-index DELETIONS go last in descending recorded order.
  const book: ApplyBook = { removed: new Set(), replaced: new Map() };
  for (const op of ops) {
    if (op.op === "entity") applyEntityLevelDoc(doc, op.c, op.chosen, side);
  }
  const keyedMeta = keyedMetaByArrayPath(ops);
  const capturedSets: CapturedPointerOp[] = [];
  const capturedDeletes: CapturedPointerOp[] = [];
  for (const op of ops) {
    if (op.op === "pointer-set") capturedSets.push(capturePointerOp(doc, "pointer-set", op.c, op.chosen, keyedMeta));
    else if (op.op === "pointer-delete") capturedDeletes.push(capturePointerOp(doc, "pointer-delete", op.c, undefined, keyedMeta));
  }
  for (const op of ops) {
    if (op.op === "reorder") applyReorder(doc, op.c, op.chosen);
  }
  for (const op of ops) {
    if (op.op === "keyed") applyKeyedElement(doc, op.c, op.chosen, book);
  }
  for (const cap of capturedSets) applyCapturedOp(doc, cap, book);
  const sortedDeletes = [...capturedDeletes].sort((a, b) => capturedDeleteIndex(b) - capturedDeleteIndex(a));
  for (const cap of sortedDeletes) applyCapturedOp(doc, cap, book);
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
