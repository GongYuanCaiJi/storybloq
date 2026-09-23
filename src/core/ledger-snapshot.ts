/**
 * T-526 (plan 3.2): the ledger as it was at a commit.
 *
 * `readLedgerSnapshot(root, oid)` reads `.story/` out of git's object store,
 * never the working tree, so a checker can answer "was this entry sound at the
 * commit that shipped" rather than "is it sound in whatever is on disk now".
 * Three git calls whatever the ledger size: resolve the commit, list the
 * `.story/` tree, and read every wanted blob through one `cat-file --batch`.
 *
 * Every file comes back TYPED, and the types are the point. `absent` is git
 * saying the path is not in that tree, which is a determinate answer (no
 * catalog, so no entries). `unreadable` is a file that is there and could not
 * be used: bad JSON, a schema mismatch, a symlink, a size over the bound. A
 * caller must never read `unreadable` as `absent`: "I could not read the
 * catalog" and "there is no catalog" are the confusion the typed statuses
 * exist to prevent, the same line `loadRulingsSafe` draws with
 * `unavailableIds`. A commit that does not resolve makes the whole snapshot
 * `oid-unavailable`, so no family can be concluded from it at all.
 *
 * Nothing here writes. Git is asked about this repository's objects only
 * (`GIT_NO_LAZY_FETCH`), so a partial clone never reaches the network for a
 * historical ledger.
 */

import { spawn } from "node:child_process";
import { CapabilityCatalogSchema, type Capability } from "../models/capability.js";
import { GlossaryCatalogSchema, type Term } from "../models/glossary.js";
import { RulingSchema, type Ruling } from "../models/ruling.js";
import { NoteSchema, type Note } from "../models/note.js";
import { IssueSchema, type Issue } from "../models/issue.js";
import { TicketSchema, type Ticket } from "../models/ticket.js";
import { RULING_CANONICAL_ID_REGEX } from "../models/types.js";
import { CATALOG_MAX_BYTES } from "./catalog.js";
import { RULING_MAX_BYTES, type LoadRulingsResult } from "./ruling-loader.js";
import { buildSuccessorIndex, lifecycleMapFor } from "./ruling.js";
import { sanitizeDisplayText } from "./display-text.js";

/** One git subprocess may take this long before it is killed. */
export const SNAPSHOT_GIT_TIMEOUT_MS = 20_000;

/** Largest single-record file read from history (tickets, issues, notes). */
export const SNAPSHOT_RECORD_MAX_BYTES = 1_000_000;
/**
 * Ceiling on one git subprocess's stdout. Sizes are checked from the tree
 * listing before any blob is requested, so this is the second line: output
 * past it kills the child and reads as a failed call, never as a buffer grown
 * without limit.
 */
export const SNAPSHOT_GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type SnapshotFileStatus =
  | { readonly kind: "ok" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** A single-document family: the parsed entries, or why there are none. */
export type SnapshotCatalogRead<T> =
  | { readonly kind: "ok"; readonly entries: readonly T[] }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** A directory family: the records that parsed, plus every file that did not. */
export interface SnapshotDirectoryRead<T> {
  /** False only when the snapshot itself is `oid-unavailable`. */
  readonly available: boolean;
  readonly records: readonly T[];
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
}

export interface LedgerSnapshot {
  /** The oid as the caller passed it. */
  readonly oid: string;
  /** The full commit id it resolved to, or null when it did not resolve. */
  readonly commit: string | null;
  readonly availability: { readonly kind: "ok" } | { readonly kind: "oid-unavailable"; readonly reason: string };
  /**
   * What a snapshot does NOT cover. Path existence, symlink containment and
   * CLI/MCP surface names are checked against the working tree and the
   * running registry, never against history; every checker result built from
   * a snapshot carries this so a reader never mistakes it for a historical
   * filesystem check.
   */
  readonly filesystemChecks: "working-tree";
  /** The status of one repo-relative path (`.story/capabilities.json`). */
  status(path: string): SnapshotFileStatus | { readonly kind: "oid-unavailable" };
  capabilities(): SnapshotCatalogRead<Capability> | { readonly kind: "oid-unavailable"; readonly reason: string };
  terms(): SnapshotCatalogRead<Term> | { readonly kind: "oid-unavailable"; readonly reason: string };
  rulings(): SnapshotDirectoryRead<Ruling>;
  notes(): SnapshotDirectoryRead<Note>;
  issues(): SnapshotDirectoryRead<Issue>;
  tickets(): SnapshotDirectoryRead<Ticket>;
  /** The rulings family in `loadRulingsSafe`'s own shape, so every consumer of that scan reads a snapshot unchanged. */
  rulingsScan(): LoadRulingsResult;
  /**
   * The committed BYTES of one path, for a caller that must write them back
   * exactly (a restore). Present whenever the blob was fetched, including a
   * blob that failed its schema, so `status` still says whether it parsed.
   * A path never fetched (absent, a symlink, over its size bound) has none.
   */
  bytes(path: string): Buffer | null;
}

export const CAPABILITIES_PATH = ".story/capabilities.json";
export const GLOSSARY_PATH = ".story/glossary.json";
const DIRECTORY_FAMILIES = ["notes", "rulings", "issues", "tickets"] as const;
type DirectoryFamily = (typeof DIRECTORY_FAMILIES)[number];

interface GitResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Test seam: the git subprocess, with optional stdin. */
export type SnapshotGitRunner = (root: string, args: readonly string[], input?: string) => Promise<GitResult>;

const realGit: SnapshotGitRunner = (root, args, input) =>
  new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", root, ...args], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflowed = false;
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SNAPSHOT_GIT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      if (overflowed) return;
      outBytes += b.length;
      if (outBytes > SNAPSHOT_GIT_MAX_OUTPUT_BYTES) {
        overflowed = true;
        out.length = 0;
        child.kill("SIGKILL");
        return;
      }
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf-8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout: Buffer.alloc(0), stderr: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(overflowed ? { code: null, stdout: Buffer.alloc(0), stderr: err } : { code, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly blob: string;
  /** Blob size in bytes; null for an entry git reports no size for (`-`). */
  readonly size: number | null;
  readonly path: string;
}

/** `ls-tree -r -z -l` records: `<mode> SP <type> SP <oid> SP+ <size> TAB <path> NUL`. */
function parseTree(stdout: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.toString("utf-8").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, blob, rawSize] = record.slice(0, tab).split(/ +/);
    if (!mode || !type || !blob) continue;
    const size = rawSize !== undefined && /^\d+$/.test(rawSize) ? Number(rawSize) : null;
    entries.push({ mode, type, blob, size, path: record.slice(tab + 1) });
  }
  return entries;
}

/** The family a path belongs to, or null for a path no snapshot consumer reads. */
function familyOf(path: string): "capabilities" | "glossary" | DirectoryFamily | null {
  if (path === CAPABILITIES_PATH) return "capabilities";
  if (path === GLOSSARY_PATH) return "glossary";
  for (const family of DIRECTORY_FAMILIES) {
    const prefix = `.story/${family}/`;
    // Direct children only, as the working-tree loaders read them.
    if (path.startsWith(prefix) && path.endsWith(".json") && !path.slice(prefix.length).includes("/")) return family;
  }
  return null;
}

function boundFor(family: ReturnType<typeof familyOf>): number {
  if (family === "capabilities" || family === "glossary") return CATALOG_MAX_BYTES;
  if (family === "rulings") return RULING_MAX_BYTES;
  return SNAPSHOT_RECORD_MAX_BYTES;
}

/**
 * `cat-file --batch` output: `<oid> SP <type> SP <size> LF <content> LF` per
 * request, or `<oid> SP missing LF`. Sizes are BYTES, so the parse walks the
 * buffer rather than the decoded string.
 */
function parseBatch(stdout: Buffer): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  let at = 0;
  while (at < stdout.length) {
    const lf = stdout.indexOf(0x0a, at);
    if (lf === -1) break;
    const header = stdout.subarray(at, lf).toString("utf-8").split(" ");
    at = lf + 1;
    const oid = header[0] ?? "";
    if (header[1] === "missing" || header.length < 3) {
      out.set(oid, null);
      continue;
    }
    const size = Number(header[2]);
    if (!Number.isFinite(size) || at + size > stdout.length) break;
    out.set(oid, stdout.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

type ParsedFile = { readonly status: SnapshotFileStatus; readonly value?: unknown; readonly bytes?: Buffer };

/**
 * JSON and schema failures are described by a fixed phrase and the issue CODE
 * only. The bytes are committed content, and a parser message quotes them, so
 * the reason never carries a fragment of the file.
 */
function parseWith(bytes: Buffer, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: { code: string }[] } } }): ParsedFile {
  const text = bytes.toString("utf-8");
  if (text.trim().length === 0) return { status: { kind: "unreadable", reason: "empty or whitespace-only" } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: { kind: "unreadable", reason: "not valid JSON" } };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { status: { kind: "unreadable", reason: `schema mismatch (${parsed.error?.issues[0]?.code ?? "invalid"})` } };
  return { status: { kind: "ok" }, value: parsed.data };
}

function schemaFor(family: NonNullable<ReturnType<typeof familyOf>>) {
  switch (family) {
    case "capabilities":
      return CapabilityCatalogSchema;
    case "glossary":
      return GlossaryCatalogSchema;
    case "rulings":
      return RulingSchema;
    case "notes":
      return NoteSchema;
    case "issues":
      return IssueSchema;
    case "tickets":
      return TicketSchema;
  }
}

function unavailableSnapshot(oid: string, reason: string): LedgerSnapshot {
  const gone = { kind: "oid-unavailable" as const, reason };
  const emptyDir = { available: false, records: [], unreadable: [] };
  return {
    oid,
    commit: null,
    availability: gone,
    filesystemChecks: "working-tree",
    status: () => ({ kind: "oid-unavailable" }),
    capabilities: () => gone,
    terms: () => gone,
    rulings: () => emptyDir,
    notes: () => emptyDir,
    issues: () => emptyDir,
    tickets: () => emptyDir,
    bytes: () => null,
    rulingsScan: () => ({
      rulings: [],
      warnings: [`ledger snapshot unavailable: ${reason}`],
      unavailableIds: new Set(),
      scanCompleteness: "incomplete",
      hasUnrecoverableEntries: true,
      lifecycleById: new Map(),
    }),
  };
}

/**
 * The ledger at `oid`. Never throws for a git failure: an unresolvable oid, a
 * failed tree listing and a failed batch read all come back as
 * `oid-unavailable`, because any of them leaves every family unconcluded.
 */
export async function readLedgerSnapshot(root: string, oid: string, git: SnapshotGitRunner = realGit): Promise<LedgerSnapshot> {
  // An option-looking oid would be read by git as a flag.
  if (oid.length === 0 || oid.startsWith("-")) return unavailableSnapshot(oid, `not a commit id: ${sanitizeDisplayText(oid, 80)}`);
  const resolved = await git(root, ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`]);
  const commit = resolved.code === 0 ? resolved.stdout.toString("utf-8").trim() : "";
  if (commit.length === 0) return unavailableSnapshot(oid, `commit ${sanitizeDisplayText(oid, 80)} does not resolve in this repository`);

  const listed = await git(root, ["ls-tree", "-r", "-z", "-l", commit, "--", ".story/"]);
  if (listed.code !== 0) return unavailableSnapshot(oid, `could not list .story/ at ${commit}`);

  const files = new Map<string, ParsedFile>();
  const wanted: { entry: TreeEntry; family: NonNullable<ReturnType<typeof familyOf>> }[] = [];
  for (const entry of parseTree(listed.stdout)) {
    const family = familyOf(entry.path);
    if (family === null) continue;
    if (entry.type !== "blob" || entry.mode === "120000") {
      // A symlink is stored as its link text; a gitlink is another repository.
      // Neither is a ledger record, and neither is absent.
      files.set(entry.path, { status: { kind: "unreadable", reason: "not a regular file" } });
      continue;
    }
    // Sized from the listing, so an oversized blob is never fetched.
    if (entry.size === null || entry.size > boundFor(family)) {
      files.set(entry.path, { status: { kind: "unreadable", reason: entry.size === null ? "size unknown" : `exceeds ${boundFor(family)} bytes` } });
      continue;
    }
    wanted.push({ entry, family });
  }

  if (wanted.length > 0) {
    const batch = await git(root, ["cat-file", "--batch"], wanted.map((w) => w.entry.blob).join("\n") + "\n");
    if (batch.code !== 0) return unavailableSnapshot(oid, `could not read .story/ blobs at ${commit}`);
    const blobs = parseBatch(batch.stdout);
    for (const { entry, family } of wanted) {
      const bytes = blobs.get(entry.blob);
      if (bytes === undefined || bytes === null) {
        files.set(entry.path, { status: { kind: "unreadable", reason: "blob missing from the object store" } });
        continue;
      }
      if (bytes.length > boundFor(family)) {
        files.set(entry.path, { status: { kind: "unreadable", reason: `exceeds ${boundFor(family)} bytes` } });
        continue;
      }
      files.set(entry.path, { ...parseWith(bytes, schemaFor(family)), bytes });
    }
  }

  const status = (path: string): SnapshotFileStatus => files.get(path)?.status ?? { kind: "absent" };

  function catalog<T>(path: string, key: "capabilities" | "terms"): SnapshotCatalogRead<T> {
    const file = files.get(path);
    if (file === undefined) return { kind: "absent" };
    if (file.status.kind === "unreadable") return file.status;
    return { kind: "ok", entries: ((file.value as Record<string, unknown>)[key] ?? []) as T[] };
  }

  function directory<T>(family: DirectoryFamily, accept?: (path: string, value: T) => string | null): SnapshotDirectoryRead<T> {
    const records: T[] = [];
    const unreadable: { path: string; reason: string }[] = [];
    const prefix = `.story/${family}/`;
    for (const [path, file] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!path.startsWith(prefix)) continue;
      if (file.status.kind === "unreadable") {
        unreadable.push({ path, reason: file.status.reason });
        continue;
      }
      const refusal = accept?.(path, file.value as T) ?? null;
      if (refusal !== null) {
        unreadable.push({ path, reason: refusal });
        continue;
      }
      records.push(file.value as T);
    }
    return { available: true, records, unreadable };
  }

  // Same filename-equals-id discipline as `loadRulingsSafe`.
  const rulingAccept = (path: string, value: Ruling): string | null =>
    path === `.story/rulings/${value.id}.json` ? null : "filename does not match record id";

  return {
    oid,
    commit,
    availability: { kind: "ok" },
    filesystemChecks: "working-tree",
    status,
    capabilities: () => catalog<Capability>(CAPABILITIES_PATH, "capabilities"),
    terms: () => catalog<Term>(GLOSSARY_PATH, "terms"),
    rulings: () => directory<Ruling>("rulings", rulingAccept),
    notes: () => directory<Note>("notes"),
    issues: () => directory<Issue>("issues"),
    tickets: () => directory<Ticket>("tickets"),
    bytes: (path) => files.get(path)?.bytes ?? null,
    rulingsScan: (): LoadRulingsResult => {
      const read = directory<Ruling>("rulings", rulingAccept);
      const unavailableIds = new Set<string>();
      let hasUnrecoverableEntries = false;
      for (const bad of read.unreadable) {
        const base = bad.path.slice(".story/rulings/".length, -".json".length);
        if (RULING_CANONICAL_ID_REGEX.test(base)) unavailableIds.add(base);
        else hasUnrecoverableEntries = true;
        // A misnamed record parsed cleanly, so its own id is known and real:
        // mark it unavailable too, as `loadRulingsSafe` does.
        const file = files.get(bad.path);
        if (file?.status.kind === "ok") unavailableIds.add((file.value as Ruling).id);
      }
      const rulings = [...read.records];
      return {
        rulings,
        warnings: read.unreadable.map((u) => `${sanitizeDisplayText(u.path)} at ${commit.slice(0, 12)}: ${sanitizeDisplayText(u.reason)}`),
        unavailableIds,
        scanCompleteness: "complete",
        hasUnrecoverableEntries,
        lifecycleById: lifecycleMapFor(rulings, buildSuccessorIndex(rulings)),
      };
    },
  };
}
