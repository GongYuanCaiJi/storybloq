import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { BusError } from "./errors.js";

export interface BusPaths {
  readonly projectRoot: string;
  readonly storyRoot: string;
  readonly busRoot: string;
  readonly threads: string;
  readonly endpoints: string;
  readonly succession: string;
  readonly mailboxes: string;
  readonly idempotency: string;
  readonly locks: string;
}

const ENDPOINT_FILENAME = /^([0-9a-f-]{36})\.json$/i;
const EndpointIdSchema = z.string().uuid();

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BusError("invalid_input", `${label} cannot be a symlink`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function assertBusIgnoreFileSafe(storyRoot: string): Promise<void> {
  const path = join(storyRoot, ".gitignore");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BusError("invalid_input", ".story/.gitignore must be a regular file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function assertBusRuntimeIgnored(storyRoot: string): Promise<void> {
  await assertBusIgnoreFileSafe(storyRoot);
  let raw: string;
  try {
    raw = await readFile(join(storyRoot, ".gitignore"), "utf-8");
  } catch (err) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus setup` first.",
      err,
    );
  }
  let ignored = false;
  for (const entry of raw.split(/\r?\n/).map((line) => line.trim())) {
    const normalized = entry.startsWith("/") ? entry.slice(1) : entry;
    const pattern = normalized.startsWith("!/") ? `!${normalized.slice(2)}` : normalized;
    if (pattern === "bus/") ignored = true;
    else if (pattern === "!bus" || pattern.startsWith("!bus/")) ignored = false;
    else if (pattern.startsWith("!")) {
      throw new BusError("conflict", "Bus ignore safety cannot be verified with negation patterns");
    }
  }
  if (!ignored) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus setup` first.",
    );
  }
}

export async function resolveBusPaths(projectRoot: string, _create?: false): Promise<BusPaths> {
  let canonicalProject: string;
  try {
    canonicalProject = await realpath(resolve(projectRoot));
  } catch (err) {
    throw new BusError("not_found", `Cannot resolve project root: ${projectRoot}`, err);
  }
  const storyRoot = join(canonicalProject, ".story");
  await rejectSymlink(storyRoot, ".story");
  try {
    const storyStat = await lstat(storyRoot);
    if (!storyStat.isDirectory()) throw new BusError("invalid_input", ".story is not a directory");
  } catch (err) {
    if (err instanceof BusError) throw err;
    throw new BusError("not_found", "No .story project found", err);
  }

  const busRoot = join(storyRoot, "bus");
  await rejectSymlink(busRoot, ".story/bus");
  const paths: BusPaths = {
    projectRoot: canonicalProject,
    storyRoot,
    busRoot,
    threads: join(busRoot, "threads"),
    endpoints: join(busRoot, "endpoints"),
    succession: join(busRoot, "succession"),
    mailboxes: join(busRoot, "mailboxes"),
    idempotency: join(busRoot, "idempotency"),
    locks: join(busRoot, "locks"),
  };
  for (const [path, label] of [
    [paths.threads, ".story/bus/threads"],
    [paths.endpoints, ".story/bus/endpoints"],
    [paths.succession, ".story/bus/succession"],
    [paths.mailboxes, ".story/bus/mailboxes"],
    [paths.idempotency, ".story/bus/idempotency"],
    [paths.locks, ".story/bus/locks"],
  ] as const) {
    await rejectSymlink(path, label);
  }
  return paths;
}

// The v2 layout drops the hardcoded implementer/reviewer mailbox subdirs; each
// endpoint owns a mailbox created lazily at join. These are the always-required
// structural directories; per-endpoint mailbox dirs are validated separately.
export function requiredBusDirectories(paths: BusPaths): string[] {
  return [
    paths.busRoot,
    paths.threads,
    paths.endpoints,
    paths.succession,
    paths.mailboxes,
    paths.idempotency,
    paths.locks,
  ];
}

export async function createBusPathsForInitialization(projectRoot: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(projectRoot);
  await assertBusRuntimeIgnored(paths.storyRoot);
  for (const directory of requiredBusDirectories(paths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rejectSymlink(directory, relative(paths.projectRoot, directory));
  }
  return paths;
}

export async function busRuntimeExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BusError("io_error", `Cannot inspect Bus runtime: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

async function endpointMailboxDirectories(paths: BusPaths): Promise<{ directories: string[]; findings: string[] }> {
  let entries;
  try {
    entries = await readdir(paths.endpoints, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { directories: [], findings: [] };
    // A non-ENOENT enumeration failure (EACCES, EIO, ...) must fail CLOSED as a layout
    // finding rather than throw a raw filesystem error out of busLayoutFindings/doctor.
    // An unreadable endpoints dir could hide active endpoint records, so it is treated
    // as corruption the Bus error contract surfaces, not an unhandled exception.
    return { directories: [], findings: [`layout: cannot enumerate ${paths.endpoints}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const directories: string[] = [];
  const findings: string[] = [];
  for (const entry of entries) {
    // Node readdir never yields `.`/`..`; guard them only in case a future API does.
    // A dot-prefixed entry is NOT skipped: durable-write temp files are named
    // `<target>.tmp.<pid>.<uuid>` (never dot-prefixed), so a dot-prefixed name where
    // an endpoint record belongs is always unexpected and must be reported, not
    // hidden (renaming `<uuid>.json` to `.<uuid>.json` would otherwise re-open the
    // fail-open by hiding an active endpoint from the layout scan).
    if (entry.name === "." || entry.name === "..") continue;
    // A symlink, a non-regular file, a dot-prefixed name, or a stem that matches the
    // 36-char filename shape but is not a valid UUID is an unexpected entry where an
    // active endpoint record belongs. Silently skipping it (the previous behavior) let
    // a runtime whose active endpoint record was replaced by a symlink or directory
    // pass assertBusLayout; record a finding instead so the layout assertion rejects it.
    const match = ENDPOINT_FILENAME.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match ||
        !EndpointIdSchema.safeParse(match[1]!).success) {
      findings.push(`layout: ${join(paths.endpoints, entry.name)} is not a regular <uuid>.json endpoint record`);
      continue;
    }
    const mailbox = join(paths.mailboxes, match[1]!);
    directories.push(mailbox, join(mailbox, "pending"));
  }
  return { directories, findings };
}

export async function busLayoutFindings(paths: BusPaths): Promise<string[]> {
  const findings: string[] = [];
  const mailboxes = await endpointMailboxDirectories(paths);
  findings.push(...mailboxes.findings);
  const directories = [...requiredBusDirectories(paths), ...mailboxes.directories];
  for (const directory of directories) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        findings.push(`layout: ${directory} is not a regular directory`);
      }
    } catch (err) {
      findings.push(`layout: ${directory}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}

export async function assertBusLayout(paths: BusPaths): Promise<void> {
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) throw new BusError("corrupt", findings.join("; "));
}

export function assertContainedPath(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BusError("invalid_input", `Bus path escapes runtime root: ${target}`);
  }
}

export function endpointMailboxPath(paths: BusPaths, endpointId: string): string {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const path = join(paths.mailboxes, endpointId);
  assertContainedPath(paths.mailboxes, path);
  return path;
}
