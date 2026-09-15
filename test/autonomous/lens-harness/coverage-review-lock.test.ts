/**
 * ISS-950 gate round 2: the downgrade-only rule has to hold for the verdict a
 * call RETURNS, not only for what it later persists.
 *
 * The merge under the shared-file lock keeps the strictest basis on disk, but
 * that is the wrong guarantee on its own. Two calls for one review can both
 * read unrestricted memory; A then persists `self-reported`; B, still holding
 * the snapshot it read before A wrote, RETURNS `not-applicable`. B's merge
 * afterwards keeps A's restriction on disk and the ledger is consistent, but
 * B's verdict has already cleared the cap it should have paid. The same window
 * loses a relabel: B cannot see the skip A recorded, so a flip to `ok` with
 * zero findings passes unflagged.
 *
 * The close is a PER-REVIEW lock, held across the read, the pipeline and the
 * persist. Only calls for the same `reviewId` contend; a session running two
 * unrelated reviews serializes neither.
 *
 * The concurrency here is REAL: a second OS process driving `handleSynthesize`
 * against the same session directory. An in-process simulation would prove
 * nothing about a lock whose whole job is cross-process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  acquireReviewCoverageLock,
  coverageMemoryPath,
} from "../../../src/autonomous/lens-harness/coverage-memory.js";
import { handleSynthesize } from "../../../src/autonomous/lens-harness/synthesize.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SYNTH = join(pkgRoot, "src", "autonomous", "lens-harness", "synthesize.js");

const CORE = ["security", "error-handling", "clean-code", "concurrency"] as const;
const LENS = "error-handling";

/** A code change: applicable to `error-handling`, so a skip on it is self-reported. */
const CODE_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string): string {",
  '+  console.log("debug");',
  '   return "hello " + name;',
  " }",
  "",
].join("\n");

/** A docs-only change: not applicable to any core lens. */
const DOCS_DIFF = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,2 +1,3 @@",
  " intro",
  "+a new sentence",
  " outro",
  "",
].join("\n");

/**
 * The child driver. It runs the REAL `handleSynthesize` in its own process and
 * prints the one coverage entry under test plus whatever the call disclosed
 * about its own degradation.
 */
const CHILD_SOURCE = `
import { writeFileSync } from "node:fs";
import { handleSynthesize } from ${JSON.stringify(SYNTH)};
const a = JSON.parse(process.argv[2]);
// The readiness handshake, and it is what makes the race deterministic rather
// than a bet on timing. Starting a tsx child costs far more than any margin
// worth sleeping, so the parent waits for THIS file instead of for a clock:
// everything after it is the call under test, and an implementation that does
// not wait for the lock reads the memory within microseconds of this line.
if (a.readyFile) writeFileSync(a.readyFile, "ready");
const out = handleSynthesize({
  stage: "CODE_REVIEW",
  lensResults: a.lenses.map((lens) => ({
    lens,
    output: lens === a.lens
      ? { status: "skipped", findings: [], error: null, notes: "nothing in my domain" }
      : { status: "ok", findings: [], error: null, notes: null },
  })),
  metadata: {
    activeLenses: a.lenses,
    skippedLenses: [],
    reviewRound: a.round,
    reviewId: a.reviewId,
  },
  projectRoot: a.root,
  sessionDir: a.sessionDir,
  sessionId: "sess-1",
  diff: a.diff,
  changedFiles: a.changedFiles,
});
const entry = out.reviewVerdict.lensCoverage.find((e) => e.lensId === a.lens);
process.stdout.write(JSON.stringify({
  basis: entry ? entry.basis : null,
  verdict: out.reviewVerdict.verdict,
  coverageNotes: out.coverageNotes ?? [],
}));
`;

/** The restriction a peer call establishes: this lens skipped when it mattered. */
const peerFile = (reviewId: string) => ({
  [reviewId]: { [LENS]: { everSkipped: true, basis: "self-reported" } },
});

let root: string;
let sessionDir: string;
let childPath: string;

function runChild(args: Record<string, unknown>): Promise<{
  basis: string | null;
  verdict: string;
  coverageNotes: string[];
}> {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"), childPath, JSON.stringify(args)],
      { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", rej);
    child.on("close", (code) => {
      if (code !== 0) return rej(new Error(`child exited ${code}: ${err}`));
      try {
        res(JSON.parse(out));
      } catch {
        rej(new Error(`unparseable child output: ${out}\n${err}`));
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the child to reach the call under test. */
async function waitForReady(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(10);
  }
  throw new Error(`child never signalled ready at ${file}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-review-lock-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  childPath = join(root, "child.mts");
  writeFileSync(childPath, CHILD_SOURCE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the per-review lock closes the read-side window (ISS-950)", () => {
  it(
    "M-NO-REVIEW-LOCK: a second process cannot return not-applicable over a peer's self-reported skip",
    async () => {
      const reviewId = "rid-contended";
      // Stand in for call A, mid-flight: it holds the review's lock and has not
      // written its restriction yet. The memory is EMPTY right now, which is
      // exactly the snapshot B must not be allowed to act on.
      const lock = acquireReviewCoverageLock(sessionDir, reviewId);
      expect(lock.kind).toBe("held");

      // B starts now, against a docs-only diff, where the applicability tables
      // alone say not-applicable for every core lens.
      const readyFile = join(root, "b-ready");
      const pending = runChild({
        root,
        sessionDir,
        reviewId,
        round: 2,
        lens: LENS,
        lenses: [...CORE],
        diff: DOCS_DIFF,
        changedFiles: ["docs/guide.md"],
        readyFile,
      });

      // B has reached the call. An implementation that does not wait for the
      // lock has already read the (empty) memory by the time this returns.
      await waitForReady(readyFile);
      await sleep(150);
      // A finishes: its restriction lands.
      writeFileSync(coverageMemoryPath(sessionDir), JSON.stringify(peerFile(reviewId)));
      if (lock.kind === "held") lock.release();

      const result = await pending;
      // B waited, read A's restriction, and paid the cap.
      expect(result.basis).toBe("self-reported");
      expect(result.verdict).toBe("revise");
      // And it waited rather than degrading: a self-reported reached by giving
      // up on the lock would be the right answer for the wrong reason.
      expect(result.coverageNotes).toEqual([]);
    },
    20_000,
  );

  it(
    "two different reviews in one session do not serialize behind each other",
    async () => {
      // One review's lock is held for the whole of the other's call.
      const lock = acquireReviewCoverageLock(sessionDir, "rid-alpha");
      expect(lock.kind).toBe("held");
      try {
        const result = await runChild({
          root,
          sessionDir,
          reviewId: "rid-beta",
          round: 1,
          lens: LENS,
          lenses: [...CORE],
          diff: DOCS_DIFF,
          changedFiles: ["docs/guide.md"],
        });
        // Unblocked, and undegraded: an honest skip on a docs-only change.
        expect(result.basis).toBe("not-applicable");
        expect(result.coverageNotes).toEqual([]);
        expect(result.verdict).toBe("approve");
      } finally {
        if (lock.kind === "held") lock.release();
      }
    },
    20_000,
  );
});

describe("an unavailable review lock degrades, never escapes (ISS-950)", () => {
  it("M-UNLOCKED-FALLBACK: every skip is self-reported and the reason is disclosed", () => {
    const reviewId = "rid-jammed";
    const lock = acquireReviewCoverageLock(sessionDir, reviewId);
    expect(lock.kind).toBe("held");
    try {
      // The same docs-only change that approves when the lock is available.
      const out = handleSynthesize({
        stage: "CODE_REVIEW",
        lensResults: CORE.map((lens) => ({
          lens,
          output: { status: "skipped", findings: [], error: null, notes: null },
        })),
        metadata: {
          activeLenses: [...CORE],
          skippedLenses: [],
          reviewRound: 1,
          reviewId,
        },
        projectRoot: root,
        sessionDir,
        sessionId: "sess-1",
        diff: DOCS_DIFF,
        changedFiles: ["docs/guide.md"],
      });

      for (const lens of CORE) {
        const entry = out.reviewVerdict.lensCoverage.find((e) => e.lensId === lens);
        expect(entry?.basis, `${lens} basis`).toBe("self-reported");
      }
      expect(out.reviewVerdict.verdict).toBe("revise");
      expect(out.coverageNotes.join(" ")).toMatch(/lock/i);
    } finally {
      if (lock.kind === "held") lock.release();
    }
  }, 20_000);

  it("M-UNLOCKED-FALLBACK: no relabel is judged when the lock could not be taken", () => {
    const reviewId = "rid-jammed-relabel";
    // On the record: this lens skipped earlier. Normally the zero-finding `ok`
    // below is a relabel. Without the lock the harness cannot trust what it
    // read, so it makes no such claim rather than a claim it cannot stand up.
    writeFileSync(
      coverageMemoryPath(sessionDir),
      JSON.stringify({ [reviewId]: { [LENS]: { everSkipped: true, basis: "self-reported" } } }),
    );
    const lock = acquireReviewCoverageLock(sessionDir, reviewId);
    expect(lock.kind).toBe("held");
    try {
      const out = handleSynthesize({
        stage: "CODE_REVIEW",
        lensResults: CORE.map((lens) => ({
          lens,
          output: { status: "ok", findings: [], error: null, notes: null },
        })),
        metadata: {
          activeLenses: [...CORE],
          skippedLenses: [],
          reviewRound: 2,
          reviewId,
        },
        projectRoot: root,
        sessionDir,
        sessionId: "sess-1",
        diff: CODE_DIFF,
        changedFiles: ["src/example.ts"],
      });

      const entry = out.reviewVerdict.lensCoverage.find((e) => e.lensId === LENS);
      expect(entry?.relabeled).toBeUndefined();
      expect(out.coverageNotes.join(" ")).toMatch(/lock/i);
    } finally {
      if (lock.kind === "held") lock.release();
    }
  }, 20_000);

  it("a sessionless synthesize takes no lock and discloses nothing", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: CORE.map((lens) => ({
        lens,
        output: { status: "skipped", findings: [], error: null, notes: null },
      })),
      metadata: { activeLenses: [...CORE], skippedLenses: [], reviewRound: 1, reviewId: "rid-loose" },
      projectRoot: root,
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
    });
    // No session directory means no memory to race over: the tables alone
    // decide, exactly as before.
    expect(out.coverageNotes).toEqual([]);
    expect(out.reviewVerdict.verdict).toBe("approve");
  });

  it("the lock file is scoped to the review and lives in the session telemetry dir", () => {
    const lock = acquireReviewCoverageLock(sessionDir, "rid/../with spaces");
    expect(lock.kind).toBe("held");
    if (lock.kind === "held") lock.release();
    // A reviewId is caller-supplied text; it must never reach the filesystem
    // as a path. Nothing escaped the telemetry directory.
    const memory = coverageMemoryPath(sessionDir);
    expect(() => readFileSync(memory)).toThrow();
  });
});
