/**
 * ISS-1211: one repo, one boundary series.
 *
 * `.story/` is local, gitignored state, so every linked git worktree carries a
 * second `.story/` beside the main checkout's. A compaction boundary seen
 * while a session's cwd was a worktree therefore landed in that worktree's
 * ledger, and the main checkout reported zero compactions for a session that
 * demonstrably compacted.
 *
 * Routing fixes that in one direction each way: every WRITE goes to the main
 * worktree's `.story/`, and every READ takes the union of the main checkout
 * and its worktrees, so a boundary is recorded once per repo while entries
 * already stranded in a worktree are still counted.
 *
 * Cost: at most ONE `git worktree list` per process, memoized per root and
 * shared by the read and the write path, because this sits on the prompt
 * hook's path and that whole path has roughly a 500 ms budget. Any git
 * failure, a checkout that is not a worktree, and a main checkout with no
 * `.story/` all resolve to the caller's own root, which is exactly the
 * pre-ISS-1211 behavior.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { directoryIdentity } from "../../presence/io.js";
import { assertNoSymlinkOnPath } from "../skill-sync-check.js";
import { discoverWorktreeRoots, type WorktreeWalkOptions } from "./presence-bridge.js";

/** `.story/telemetry/<this>`: the boundary ledger's directory. */
export const LEDGER_SUBDIR = "session-intel";

/** Same cap the presence walk uses; applied to `git worktree list` itself. */
export const LEDGER_WORKTREE_LIMIT = 32;

export interface LedgerRouting {
  /** The checkout that owns the shared series. `root` itself for a plain checkout. */
  readonly mainRoot: string;
  /** Every OTHER safe checkout of the same repo: `mainRoot` and `root` excluded. */
  readonly linkedRoots: readonly string[];
}

const routingCache = new Map<string, LedgerRouting>();

/**
 * Forgets what git reported. Tests call it between fixtures; a long-lived
 * server may call it when its project root changes underneath it.
 */
export function resetLedgerRoutingCache(): void {
  routingCache.clear();
}

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Identity of the caller's OWN root, following symlinks deliberately: `root`
 * is the caller's trusted argument, and `git worktree list` reports realpaths,
 * so a root reached through a symlinked ancestor would never string-match its
 * own entry. Same reasoning as `findPresenceRecordAcrossWorktrees`.
 */
function ownIdentity(root: string): Identity | null {
  try {
    const st = fs.statSync(root);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * A candidate checkout is usable when it is itself a real directory (not a
 * symlink: a registered worktree path can be replaced after registration), it
 * ALREADY holds a real `.story/` directory (never created here, so a checkout
 * that is not a storybloq project is left alone), and no component down to the
 * ledger directory is a symlink. Same discipline as the presence walk's own
 * candidate check; the identity returned is the very `lstatSync` the symlink
 * check used, so capture and validation happen together.
 */
function safeLedgerRoot(candidate: string): Identity | null {
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (directoryIdentity(join(candidate, ".story")) === null) return null;
    assertNoSymlinkOnPath(candidate, join(candidate, ".story", "telemetry", LEDGER_SUBDIR));
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

const same = (a: Identity | null, b: Identity | null) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

function resolveRouting(root: string, opts: WorktreeWalkOptions): LedgerRouting {
  const self = ownIdentity(root);
  // git-worktree(1): "The main worktree is listed first, followed by each of
  // the linked worktrees." `[]` covers an absent git, a non-repository, and a
  // timeout, and is the signal to stay entirely local.
  const roots = discoverWorktreeRoots(root, { ...opts, limit: LEDGER_WORKTREE_LIMIT });
  if (roots.length === 0) return { mainRoot: root, linkedRoots: [] };
  const mainCandidate = safeLedgerRoot(roots[0]!);
  const routeAway = mainCandidate !== null && !same(mainCandidate, self);
  const mainRoot = routeAway ? roots[0]! : root;
  const mainIdentity = routeAway ? mainCandidate : self;
  const linkedRoots: string[] = [];
  for (const candidate of roots) {
    const identity = safeLedgerRoot(candidate);
    if (identity === null) continue;
    if (same(identity, self) || same(identity, mainIdentity)) continue;
    linkedRoots.push(candidate);
  }
  return { mainRoot, linkedRoots };
}

/** The repo's ledger routing, resolved at most once per root per process. */
export function ledgerRouting(root: string, opts: WorktreeWalkOptions = {}): LedgerRouting {
  const cached = routingCache.get(root);
  if (cached) return cached;
  const routing = resolveRouting(root, opts);
  routingCache.set(root, routing);
  return routing;
}

/** The checkout a boundary is WRITTEN to: one repo, one series. */
export function boundaryLedgerRoot(root: string, opts: WorktreeWalkOptions = {}): string {
  return ledgerRouting(root, opts).mainRoot;
}

/**
 * Every checkout a boundary may be READ from, shared series first and the
 * caller's own checkout always included, so entries stranded by the old cwd
 * routing stay visible from both sides.
 */
export function boundaryLedgerReadRoots(root: string, opts: WorktreeWalkOptions = {}): string[] {
  const { mainRoot, linkedRoots } = ledgerRouting(root, opts);
  return mainRoot === root ? [root, ...linkedRoots] : [mainRoot, root, ...linkedRoots];
}
