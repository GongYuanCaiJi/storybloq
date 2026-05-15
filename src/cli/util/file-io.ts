import { readFileSync } from "node:fs";

export type ReadResult =
  | { ok: true; content: string }
  | { ok: false; error: NodeJS.ErrnoException };

export function tryReadFile(path: string): ReadResult {
  try {
    return { ok: true, content: readFileSync(path, "utf-8") };
  } catch (err) {
    return { ok: false, error: err as NodeJS.ErrnoException };
  }
}
