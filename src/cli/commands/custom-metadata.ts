import { CliValidationError } from "../helpers.js";

const RESERVED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function cloneUnknown(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneUnknown);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneUnknown(v);
  }
  return out;
}

function parsePath(path: string): string[] {
  if (!path.trim()) {
    throw new CliValidationError("invalid_input", "Metadata path cannot be empty");
  }
  const segments = path.split(".");
  for (const segment of segments) {
    if (!segment) {
      throw new CliValidationError("invalid_input", `Invalid metadata path "${path}"`);
    }
    if (RESERVED_PATH_SEGMENTS.has(segment)) {
      throw new CliValidationError("invalid_input", `Forbidden metadata path segment "${segment}"`);
    }
  }
  return segments;
}

export function parseMetadataJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliValidationError(
      "invalid_input",
      `Metadata value must be valid JSON: ${raw}`,
    );
  }
}

export function assertMetadataPathAllowed(path: string, protectedKeys: ReadonlySet<string>): void {
  const [first] = parsePath(path);
  if (first && protectedKeys.has(first)) {
    throw new CliValidationError("invalid_input", `Cannot set metadata on core field "${first}"`);
  }
}

export function getMetadataValue(
  entity: Record<string, unknown>,
  path: string | undefined,
  protectedKeys: ReadonlySet<string>,
): unknown {
  if (!path) {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entity)) {
      if (!protectedKeys.has(key)) metadata[key] = value;
    }
    return metadata;
  }
  assertMetadataPathAllowed(path, protectedKeys);
  const segments = parsePath(path);
  let cursor: unknown = entity;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new CliValidationError("not_found", `Metadata path "${path}" not found`);
    }
    if (!(segment in (cursor as Record<string, unknown>))) {
      throw new CliValidationError("not_found", `Metadata path "${path}" not found`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function setMetadataValue<T extends Record<string, unknown>>(
  entity: T,
  path: string,
  value: unknown,
  protectedKeys: ReadonlySet<string>,
): T {
  assertMetadataPathAllowed(path, protectedKeys);
  const segments = parsePath(path);
  const root = cloneUnknown(entity) as Record<string, unknown>;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (next === undefined) {
      cursor[seg] = {};
    } else if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new CliValidationError(
        "invalid_input",
        `Cannot set metadata path "${path}" because "${segments.slice(0, i + 1).join(".")}" is not an object`,
      );
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = cloneUnknown(value);
  return root as T;
}

function pruneEmptyContainers(root: Record<string, unknown>, segments: string[]): void {
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    parents.push({ parent: cursor, key: seg });
    cursor = next as Record<string, unknown>;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    const { parent, key } = parents[i]!;
    const candidate = parent[key];
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      Object.keys(candidate as Record<string, unknown>).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
}

export function unsetMetadataValue<T extends Record<string, unknown>>(
  entity: T,
  path: string,
  protectedKeys: ReadonlySet<string>,
): T {
  assertMetadataPathAllowed(path, protectedKeys);
  const segments = parsePath(path);
  const root = cloneUnknown(entity) as Record<string, unknown>;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new CliValidationError("not_found", `Metadata path "${path}" not found`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in cursor)) {
    throw new CliValidationError("not_found", `Metadata path "${path}" not found`);
  }
  delete cursor[leaf];
  pruneEmptyContainers(root, segments);
  return root as T;
}
