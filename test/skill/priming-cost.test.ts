/**
 * Fixture note: the ticket set is 8, not 6, and a fixed literal reason why.
 *
 * storybloq_recommend does NOT recommend every unblocked ticket -- reading
 * recommend.ts's generator functions directly shows a ticket only becomes a
 * candidate by matching a SPECIFIC category (inprogress, high-impact-unblock,
 * quick-win, phase-momentum, near-complete-umbrella). T-1007/T-1008 exist
 * ONLY to give T-1003 a genuine unblockCount of 2 (high_impact_unblock's own
 * threshold) -- neither is ever itself a candidate (both are blockedBy
 * T-1003). This yields exactly 7 real recommend candidates, verified by
 * direct MCP call against this fixture, not assumed: ISS-2001 (critical),
 * T-1001 (inprogress), T-1003 (high-impact-unblock), T-1006 (phase-momentum),
 * T-1002 (quick-win), ISS-2002 (open, medium), ISS-2003 (open, low). The
 * Ready-to-Work table's "(+2 more)" suffix (7 candidates, top 5 shown) is the
 * corpus property the fixture is sized to exercise.
 *
 * m4 (normalize-before-byte-count) disposition, per the pen's explicit
 * 3-step check: session_guard/status's per-session `sourceDir` is confirmed
 * (by reading session-scan.ts) to be a bare directory NAME, never an
 * absolute path -- no leak there for a clean, guard-free (zero-session)
 * fixture. A `SessionScanDiagnostic`'s `sourcePath` field DOES embed the
 * absolute root (confirmed empirically: a UUID-shaped file, not a directory,
 * under `.story/sessions/` produces one) -- but triggering that diagnostic
 * flips `overallAction` from "free" to "unverifiable", which contradicts the
 * ticket's own "guard-free" framing this whole fixture is built around, so
 * it is not usable here without redesigning the fixture's foundational
 * guard-free property. No other measured step's real response (status is
 * aggregate-only; recap/handover_latest/lesson_digest/recommend carry no
 * paths; ticket/issue `location` fields are relative; `gitUserEmail` returns
 * null rather than surfacing cwd on failure) embeds the root either. m4 is
 * therefore INERT on this corpus: normalization is kept (live mode still
 * needs it against a real, arbitrary project root), but there is no honest
 * end-to-end mutant to prove against this fixture. The unit-level
 * `buildNormalizer` tests below remain the correctness proof for the
 * normalization logic itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  byteLength,
  buildNormalizer,
  FIXTURE_ROOT_PLACEHOLDER,
  parseRecommendMarkdown,
  deriveRecommendRows,
  findContinuationSection,
  extractEntityIds,
  issueClearsActionabilityBar,
  ticketClearsActionabilityBar,
  parseTicketMarkdown,
  parseIssueMarkdown,
  reconcileFingerprints,
  isOrchestratorConfig,
  buildFailedRecommendReport,
  buildCrashReport,
  stepReconciliation,
  runReplaySequence,
  stepRecommend,
  stepContinuationCheck,
  STEP_NAMES,
  type PrimingCostReport,
  type CapturedMessage,
  type ExchangeMeasurement,
  type ReplayContext,
} from "../../scripts/priming-cost.js";

const execFileAsync = promisify(execFileCb);

const FIXTURE_SRC = resolve(__dirname, "fixtures/priming-cost");
const SCRIPT_PATH = resolve(__dirname, "../../scripts/priming-cost.ts");
const TSX_CLI = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
const STORYBLOQ_ROOT = resolve(__dirname, "../..");

// --- child-process isolation -------------------------------------------------
//
// True process isolation, not just an in-process Date monkeypatch: real
// determinism requires isolating ambient host state (git config, environment
// identity vars), not just the clock. HOME/USERPROFILE point at a fresh empty
// dir, git config files are pointed at /dev/null, TZ is fixed, and client
// identity vars are explicitly unset (not merely inherited).

async function makeIsolatedEnv(): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const homeDir = await mkdtemp(join(tmpdir(), "priming-cost-home-"));
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    TZ: "UTC",
    PATH: "/usr/bin:/bin:/usr/local/bin",
  };
  return { env, cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}

async function runEmitJson(fixtureRoot: string): Promise<{ report: PrimingCostReport; stdout: string }> {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [TSX_CLI, SCRIPT_PATH, "--emit-json", fixtureRoot],
      { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
    );
    return { report: JSON.parse(stdout), stdout };
  } finally {
    await cleanup();
  }
}

async function copyFixture(intoDir?: string): Promise<string> {
  const dir = intoDir ?? (await mkdtemp(join(tmpdir(), "priming-cost-fx-")));
  await cp(FIXTURE_SRC, dir, { recursive: true });
  return dir;
}

// --- byteLength --------------------------------------------------------------

describe("byteLength", () => {
  it("matches Buffer.byteLength for ASCII", () => {
    expect(byteLength("hello")).toBe(5);
  });

  it("m3: reports UTF-8 byte length, not UTF-16 .length, for multibyte text", () => {
    const s = "café🎉"; // é: 1 UTF-16 unit / 2 bytes; 🎉: 2 UTF-16 units / 4 bytes
    expect(s.length).toBe(6);
    expect(byteLength(s)).toBe(9);
    expect(byteLength(s)).not.toBe(s.length);
  });
});

// --- normalization (unit-level m4) --------------------------------------------

describe("buildNormalizer", () => {
  it("replaces the exact root path wherever it appears in a string", () => {
    const root = "/tmp/some-fixture-root-abc123";
    const normalize = buildNormalizer(root);
    const input = { a: `${root}/.story/tickets/T-001.json`, b: "unrelated", c: 42 };
    expect(normalize(input)).toEqual({
      a: `${FIXTURE_ROOT_PLACEHOLDER}/.story/tickets/T-001.json`,
      b: "unrelated",
      c: 42,
    });
  });

  it("m4: produces byte-identical serialized output regardless of root path length", () => {
    const shortRoot = "/tmp/a";
    const longRoot = "/tmp/a-much-longer-directory-name-that-changes-the-string-length-considerably";
    const shortNorm = buildNormalizer(shortRoot);
    const longNorm = buildNormalizer(longRoot);

    const shortValue = { path: `${shortRoot}/.story/status.json`, note: "same content" };
    const longValue = { path: `${longRoot}/.story/status.json`, note: "same content" };

    const shortBytes = Buffer.byteLength(JSON.stringify(shortNorm(shortValue)), "utf8");
    const longBytes = Buffer.byteLength(JSON.stringify(longNorm(longValue)), "utf8");
    expect(shortBytes).toBe(longBytes);
    expect(JSON.stringify(shortNorm(shortValue))).toBe(JSON.stringify(longNorm(longValue)));
  });
});

// --- recommend markdown parsing ------------------------------------------------

describe("parseRecommendMarkdown", () => {
  it("parses id/kind/title/reason rows from the numbered-list shape", () => {
    const text = [
      "# Recommendations",
      "",
      "1. **T-1001** (ticket) -- Wire the ingest retry queue",
      "   _quick win, unblocked_",
      "",
      "2. **ISS-2001** (issue) -- Retry queue drops the final byte",
      "   _high severity, actionable_",
      "",
    ].join("\n");
    const rows = parseRecommendMarkdown(text);
    expect(rows).toEqual([
      { id: "T-1001", kind: "ticket", title: "Wire the ingest retry queue", reason: "quick win, unblocked" },
      { id: "ISS-2001", kind: "issue", title: "Retry queue drops the final byte", reason: "high severity, actionable" },
    ]);
  });
});

describe("deriveRecommendRows (strict full-response validation)", () => {
  it("accepts a fully well-formed response with a trailing 'Showing' line", () => {
    const text = [
      "# Recommendations",
      "",
      "1. **T-1001** (ticket) -- Wire the ingest retry queue",
      "   _quick win, unblocked_",
      "",
      "Showing 1 of 3 candidates.",
    ].join("\n");
    const result = deriveRecommendRows(text);
    expect(result.parseFailed).toBe(false);
    expect(result.rows).toHaveLength(1);
  });

  it("rejects a response where the second row is missing its reason line, even though the first row is well-formed", () => {
    // This is exactly the partial-acceptance risk: a lenient row-scanner
    // would happily extract row 1 and silently skip the malformed row 2,
    // understating the real candidate set (and the issue_get calls it
    // implies) instead of flagging the response as unparseable.
    const text = [
      "# Recommendations",
      "",
      "1. **T-1001** (ticket) -- Wire the ingest retry queue",
      "   _quick win, unblocked_",
      "",
      "2. **ISS-2001** (issue) -- Retry queue drops the final byte",
      "not a reason line",
      "",
    ].join("\n");
    const result = deriveRecommendRows(text);
    expect(result.parseFailed).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it("rejects a response with a skipped rank", () => {
    const text = [
      "# Recommendations",
      "",
      "1. **T-1001** (ticket) -- Wire the ingest retry queue",
      "   _quick win, unblocked_",
      "",
      "3. **ISS-2001** (issue) -- Retry queue drops the final byte",
      "   _high severity, actionable_",
      "",
    ].join("\n");
    const result = deriveRecommendRows(text);
    expect(result.parseFailed).toBe(true);
  });

  it("accepts each of the 3 known empty-state strings as a genuine empty result, not a failure", () => {
    expect(
      deriveRecommendRows("No recommendations -- all work is complete or blocked.").parseFailed,
    ).toBe(false);
  });
});

// --- continuation section parsing ---------------------------------------------

describe("findContinuationSection", () => {
  it("extracts from an actionable heading to the next heading of equal-or-higher level", () => {
    const body = [
      "# Session Handover",
      "",
      "## Earlier",
      "irrelevant",
      "",
      "## Next steps",
      "- Continue T-1002: do the thing",
      "",
      "## Notes",
      "not part of the section",
    ].join("\n");
    const section = findContinuationSection(body);
    expect(section).not.toBeNull();
    expect(section!.heading).toBe("## Next steps");
    expect(section!.content).toContain("T-1002");
    expect(section!.content).not.toContain("not part of the section");
  });

  it("returns null when no heading matches next/open/remaining/todo/blocked", () => {
    const body = ["# Handover", "", "## Summary", "nothing actionable here"].join("\n");
    expect(findContinuationSection(body)).toBeNull();
  });
});

describe("extractEntityIds", () => {
  it("returns ticket/issue ids in first-appearance order, deduplicated", () => {
    expect(extractEntityIds("see T-1002 and ISS-2001, also T-1002 again")).toEqual([
      "T-1002",
      "ISS-2001",
    ]);
  });
});

// --- actionability bar ---------------------------------------------------------

describe("actionability bar", () => {
  it("an owner-gated issue never clears", () => {
    expect(
      issueClearsActionabilityBar({ status: "open", impact: "OWNER-GATED: wait for a decision" }),
    ).toBe(false);
  });

  it("an open issue with no blocker marker clears", () => {
    expect(issueClearsActionabilityBar({ status: "open", impact: "actionable now" })).toBe(true);
  });

  it("a blocked ticket never clears", () => {
    expect(ticketClearsActionabilityBar({ status: "open", blocked: true })).toBe(false);
  });

  it("an unblocked open ticket clears", () => {
    expect(ticketClearsActionabilityBar({ status: "open", blocked: false })).toBe(true);
  });
});

describe("entity markdown parsing", () => {
  it("parseTicketMarkdown reads status and the [BLOCKED] marker", () => {
    const blocked = parseTicketMarkdown(
      "# T-1005: Migrate config schema to v3 [BLOCKED]\n\nStatus: open | Type: task | Phase: core | Order: 30\nBlocked by: T-1006",
    );
    expect(blocked).toEqual({ status: "open", blocked: true });

    const clear = parseTicketMarkdown(
      "# T-1002: Document the export CLI flags\n\nStatus: open | Type: chore | Phase: core | Order: 20",
    );
    expect(clear).toEqual({ status: "open", blocked: false });
  });

  it("parseIssueMarkdown reads status and the fenced Impact/Resolution sections", () => {
    const text = [
      "# ISS-2003: Snapshot pruning may keep stale entries under clock skew",
      "",
      "Status: open | Severity: low | Phase: none | Order: none",
      "Components: core",
      "Discovered: 2026-08-08",
      "",
      "## Impact",
      "",
      "```",
      "OWNER-GATED: pending a decision on the retention policy before any fix lands; do not treat as actionable yet.",
      "```",
    ].join("\n");
    const parsed = parseIssueMarkdown(text);
    expect(parsed.status).toBe("open");
    expect(parsed.impact).toContain("OWNER-GATED");
    expect(parsed.resolution).toBe("");
  });
});

// --- reconciliation fingerprint comparison (unit level; fixture stays guard-free) ---

describe("reconcileFingerprints", () => {
  const base = {
    sessionId: "s1",
    sourceDir: "dirA",
    population: "activeSessions",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };

  it("matches when guard and status carry identical fingerprints", () => {
    const result = reconcileFingerprints([base], [{ ...base }]);
    expect(result.matched).toBe(true);
    expect(result.mismatchedIds).toEqual([]);
  });

  const fieldMutations: Array<[string, unknown]> = [
    ["sourceDir", "dirB"],
    ["population", 4],
    ["state", "stale"],
    ["compactPending", true],
    ["leaseState", "expired"],
  ];

  for (const [field, mutated] of fieldMutations) {
    it(`reports a mismatch when only ${field} differs`, () => {
      const mutatedSession = { ...base, [field]: mutated };
      const result = reconcileFingerprints([base], [mutatedSession]);
      expect(result.matched).toBe(false);
      expect(result.mismatchedFields["s1"]).toEqual([field]);
    });
  }

  it("reports a mismatch when ownerTask client or id differs", () => {
    const result = reconcileFingerprints([base], [{ ...base, ownerTask: { client: "codex", id: "task-1" } }]);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["ownerTaskClient"]);
  });

  it("reports a mismatch when a session is present on only one side", () => {
    const result = reconcileFingerprints([base], []);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["presence"]);
  });

  it("dedupe survivor order: first occurrence on each side wins independently (when population is unset)", () => {
    const { population: _pop, ...basePop } = base as any;
    const guard = [
      { ...basePop, sourceDir: "first" },
      { ...basePop, sourceDir: "second" },
    ];
    const status = [{ ...basePop, sourceDir: "first" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: an activeSessions duplicate survives over a resumableSessions duplicate, regardless of input array order", () => {
    // The resumable copy appears FIRST in the raw input array; the dedup
    // rule must still prefer the active-population copy.
    const guard = [
      { ...base, population: "resumableSessions", sourceDir: "resumable-copy" },
      { ...base, population: "activeSessions", sourceDir: "active-copy" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "active-copy" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: within the same population, the lexically-first sourceDir survives, regardless of input array order", () => {
    const guard = [
      { ...base, population: "activeSessions", sourceDir: "z-dir" },
      { ...base, population: "activeSessions", sourceDir: "a-dir" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "a-dir" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: a mismatch is correctly detected when the wrong (non-surviving) copy would otherwise have matched", () => {
    // If dedup incorrectly kept the resumable copy (input order) instead of
    // the active copy (population order), this would report matched:true --
    // it must report a mismatch instead.
    const guard = [
      { ...base, population: "resumableSessions", sourceDir: "same-dir" },
      { ...base, population: "activeSessions", sourceDir: "same-dir", state: "active" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "same-dir", state: "stale" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["state"]);
  });
});

// --- stepReconciliation's retry path (unit level, mock ReplayContext) ---------
//
// The retry issues a REAL storybloq_session_guard call through
// ctx.client.callTool; a mock client here stands in for the real MCP client
// so this exercises stepReconciliation itself (not just reconcileFingerprints
// in isolation), proving the call actually fires and its result -- not the
// original mismatched verdict -- is what gets compared.

function makeMockReconciliationCtx(secondGuardSessions: unknown[]): {
  ctx: ReplayContext;
  calledTools: string[];
} {
  const log: CapturedMessage[] = [];
  const calledTools: string[] = [];
  let nextId = 1;
  const mockClient = {
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calledTools.push(name);
      const id = nextId++;
      log.push({
        seq: log.length,
        direction: "client-to-server",
        message: { method: "tools/call", params: { name, arguments: args }, jsonrpc: "2.0", id },
      });
      const text = JSON.stringify({ sessions: secondGuardSessions });
      log.push({
        seq: log.length,
        direction: "server-to-client",
        message: { result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id },
      });
      return undefined;
    },
  };
  const ctx: ReplayContext = {
    root: "/mock-root",
    client: mockClient as any,
    log,
    normalize: buildNormalizer("/mock-root"),
    gitLogMode: "fixture",
  };
  return { ctx, calledTools };
}

describe("stepReconciliation retry path (unit level)", () => {
  const activeStatusSession = {
    sessionId: "s1",
    sourceDir: "dirA",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };
  const guardVerdict = {
    sessions: [{ ...activeStatusSession, population: "activeSessions", state: "stale" }], // mismatched vs status on first attempt
  };
  const statusPayload = { activeSessions: [activeStatusSession], resumableSessions: [] };

  it("fires exactly one retried guard call, and a retry that now agrees reports matched", async () => {
    const { ctx, calledTools } = makeMockReconciliationCtx([
      { ...activeStatusSession, population: "activeSessions" }, // retried verdict agrees with status
    ]);
    const report = await stepReconciliation(ctx, guardVerdict, statusPayload);
    expect(calledTools).toEqual(["storybloq_session_guard"]);
    expect(report.calls).toBe(1);
    expect((report as any).verdict).toBe("matched");
    expect((report as any).matched).toBe(true);
    expect((report as any).status).toBeUndefined();
  });

  it("a persisting mismatch after the retry reports verdict 'unverifiable', not 'matched'", async () => {
    const { ctx, calledTools } = makeMockReconciliationCtx([
      { ...activeStatusSession, population: "activeSessions", state: "still-stale" }, // retried verdict STILL disagrees
    ]);
    const report = await stepReconciliation(ctx, guardVerdict, statusPayload);
    expect(calledTools).toEqual(["storybloq_session_guard"]);
    expect((report as any).verdict).toBe("unverifiable");
    expect((report as any).matched).toBe(false);
    expect((report as any).status).toBe("incomplete");
  });
});

// --- replay-level: stop-on-unverifiable and partial-progress retention -------
//
// The two tests above prove stepReconciliation's OWN returned report is
// correct. They cannot prove anything about its CALLERS (runFixtureMode /
// runLiveMode, both of which now delegate to the shared runReplaySequence):
// whether an "unverifiable" verdict actually stops the sequence, or whether a
// later crash actually preserves earlier measurements. These tests drive
// runReplaySequence itself (the exact function both modes call) with a full
// mock ReplayContext, so they exercise the real orchestration logic rather
// than a re-implementation of it.

function makeMockReplayCtx(opts: {
  statusPayload: Record<string, unknown>;
  guardSessionsByCall: unknown[][];
  throwOnTool?: string;
  /** Return genuinely-captured, but unparseable, JSON text for storybloq_status. */
  malformedStatusJson?: boolean;
  /** Log ONLY the outgoing request for this tool, then reject -- models a
   * dropped connection / timeout: a request was truly sent, but no response
   * ever arrived. */
  requestOnlyFailOnTool?: string;
  /** For this tool's call, log its request, THEN a stray server-to-client
   * NOTIFICATION (no id), THEN its real response -- proving call-counting
   * matches by JSON-RPC id rather than merely alternating direction (which
   * would mistake the notification for the reply and miscount). */
  injectNotificationMidExchangeForTool?: string;
}): { ctx: ReplayContext; calledTools: string[]; log: CapturedMessage[] } {
  const log: CapturedMessage[] = [];
  const calledTools: string[] = [];
  let nextId = 1;
  let guardCallIndex = 0;

  const pushRequest = (method: string, params: unknown, id: number): void => {
    log.push({
      seq: log.length,
      direction: "client-to-server",
      message: { method, params, jsonrpc: "2.0", id },
    });
  };
  const pushResponse = (result: unknown, id: number): void => {
    log.push({
      seq: log.length,
      direction: "server-to-client",
      message: { result, jsonrpc: "2.0", id },
    });
  };
  const pushExchange = (method: string, params: unknown, result: unknown): void => {
    const id = nextId++;
    pushRequest(method, params, id);
    pushResponse(result, id);
  };

  const mockClient = {
    listTools: async () => {
      pushExchange("tools/list", {}, { tools: [] });
      return { tools: [] };
    },
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calledTools.push(name);
      if (opts.requestOnlyFailOnTool && name === opts.requestOnlyFailOnTool) {
        // A request was genuinely sent -- logged -- but the call rejects
        // before any response is ever captured.
        pushRequest("tools/call", { name, arguments: args }, nextId++);
        throw new Error(`mock connection drop calling ${name}`);
      }
      if (opts.throwOnTool && name === opts.throwOnTool) {
        throw new Error(`mock failure calling ${name}`);
      }
      let text: string;
      if (name === "storybloq_session_guard") {
        const idx = Math.min(guardCallIndex, opts.guardSessionsByCall.length - 1);
        text = JSON.stringify({ sessions: opts.guardSessionsByCall[idx] });
        guardCallIndex++;
      } else if (name === "storybloq_status") {
        text = opts.malformedStatusJson ? "not valid json {{{" : JSON.stringify(opts.statusPayload);
      } else {
        text = JSON.stringify({});
      }
      if (opts.injectNotificationMidExchangeForTool && name === opts.injectNotificationMidExchangeForTool) {
        const id = nextId++;
        pushRequest("tools/call", { name, arguments: args }, id);
        log.push({
          seq: log.length,
          direction: "server-to-client",
          message: { method: "notifications/message", params: { level: "info" }, jsonrpc: "2.0" },
        });
        pushResponse({ content: [{ type: "text", text }] }, id);
        return undefined;
      }
      pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text }] });
      return undefined;
    },
  };

  const ctx: ReplayContext = {
    root: "/mock-root",
    client: mockClient as any,
    log,
    normalize: buildNormalizer("/mock-root"),
    gitLogMode: "fixture",
  };
  return { ctx, calledTools, log };
}

/** Independent oracle: sums raw JSON-RPC message bytes directly via
 * Buffer.byteLength, bypassing the harness's own measuredBytes/normalize
 * helpers entirely, over log entries in [start, end). Used to prove exact
 * byte retention rather than a weak `> 0` bound that prior-successful
 * exchanges would already satisfy on their own. */
function independentByteSum(log: CapturedMessage[], start: number, end: number): number {
  return log
    .slice(start, end)
    .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message), "utf8"), 0);
}

describe("runReplaySequence: stop after an unverifiable reconciliation", () => {
  const activeStatusSession = {
    sessionId: "s1",
    sourceDir: "dirA",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };
  const statusPayload = { activeSessions: [activeStatusSession], resumableSessions: [] };
  // Both the first guard call and the retried guard call disagree with
  // status on `state` -- a persisting mismatch.
  const mismatchedGuardSessions = [{ ...activeStatusSession, population: "activeSessions", state: "stale" }];

  it("fires exactly two session_guard calls, one status call, and zero downstream tool calls, retaining prior costs as observed_subtotal", async () => {
    const { ctx, calledTools } = makeMockReplayCtx({
      statusPayload,
      guardSessionsByCall: [mismatchedGuardSessions, mismatchedGuardSessions],
    });

    const { steps, anyIncomplete, orchestrator } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);
    // The early-return (stop) path must carry the same result shape as the
    // full-sequence return -- including fields, like orchestrator, that are
    // easy to leave off an early return by hand.
    expect(typeof orchestrator).toBe("boolean");

    const guardCalls = calledTools.filter((t) => t === "storybloq_session_guard");
    const statusCalls = calledTools.filter((t) => t === "storybloq_status");
    expect(guardCalls).toHaveLength(2);
    expect(statusCalls).toHaveLength(1);
    // No downstream tool beyond discovery/guard/status/reconciliation's retry
    // fires at all.
    expect(calledTools).toEqual([
      "storybloq_session_guard",
      "storybloq_status",
      "storybloq_session_guard",
    ]);

    expect(anyIncomplete).toBe(true);
    expect((steps.reconciliation as any).verdict).toBe("unverifiable");
    // session_guard, status, and reconciliation's own retry genuinely
    // transmitted -- their costs are retained, not zeroed.
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.status.calls).toBe(1);
    expect(steps.reconciliation.calls).toBe(1);
    // Every step after reconciliation never ran: zero cost, incomplete.
    const downstreamNames = STEP_NAMES.filter(
      (n) => n !== "tool_discovery" && n !== "tool_discovery_reference" && n !== "session_guard" && n !== "status" && n !== "reconciliation",
    );
    for (const name of downstreamNames) {
      expect(steps[name].calls).toBe(0);
      expect(steps[name].bytes).toBe(0);
      expect((steps[name] as any).status).toBe("incomplete");
    }
  });

  it("a retry that resolves the mismatch proceeds through the full sequence (regression: matched reconciliation does not stop)", async () => {
    const { ctx, calledTools } = makeMockReplayCtx({
      statusPayload,
      guardSessionsByCall: [
        mismatchedGuardSessions,
        [{ ...activeStatusSession, population: "activeSessions" }], // retry agrees
      ],
    });

    const { steps } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect((steps.reconciliation as any).verdict).toBe("matched");
    // Downstream steps genuinely ran (mock returns empty-shaped payloads, so
    // their own parsing may report incomplete, but they were not SKIPPED --
    // recap made a real call).
    expect(calledTools).toContain("storybloq_recap");
    expect(steps.recap.calls).toBe(1);
  });
});

describe("runReplaySequence: partial progress survives a later crash", () => {
  it("retains session_guard/status/reconciliation's genuine costs when a later step throws", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const agreeingGuardSessions = [{ ...activeStatusSession, population: "activeSessions" }];
    const { ctx, calledTools, log } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [agreeingGuardSessions],
      throwOnTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // Steps genuinely measured before the crash are RETAINED, not zeroed --
    // exact byte counts via an independent oracle, not a `> 0` bound.
    expect((steps.reconciliation as any).verdict).toBe("matched");
    // tool_discovery's own tools/list exchange occupies log[0,2); session_guard
    // is log[2,4); status is log[4,6).
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.session_guard.bytes).toBe(independentByteSum(log, 2, 4));
    expect(steps.status.calls).toBe(1);
    expect(steps.status.bytes).toBe(independentByteSum(log, 4, 6));
    // Everything from the crashing step onward is zero-cost and incomplete.
    // The mock throws before logging anything for storybloq_recap, so there
    // is genuinely nothing to recover here -- this differs from the tests
    // below, where the failing exchange IS captured before the throw.
    expect(steps.recap.calls).toBe(0);
    expect(steps.recap.bytes).toBe(0);
    expect((steps.recap as any).status).toBe("incomplete");
    expect((steps.recap as any).reason).toMatch(/replay step crashed/);
    expect(steps.node_list.calls).toBe(0);
    expect((steps.node_list as any).status).toBe("incomplete");
    expect(calledTools.filter((t) => t === "storybloq_recap")).toHaveLength(1);
    expect(calledTools).not.toContain("storybloq_handover_latest");
  });

  it("recovers a single-call step's genuine captured cost when its OWN post-processing crashes (malformed status JSON)", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx, calledTools, log } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      malformedStatusJson: true,
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // tool_discovery + session_guard genuinely completed and are retained.
    // tool_discovery is log[0,2); session_guard is log[2,4); status is log[4,6).
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.session_guard.bytes).toBe(independentByteSum(log, 2, 4));
    // storybloq_status's own JSON.parse throws on the unparseable text --
    // uncaught by stepStatus itself -- but the exchange WAS genuinely
    // captured (request + response both logged) before that crash. The
    // generic recovery in runReplaySequence's catch must attribute this to
    // "status" specifically (not "reconciliation", which STEP_NAMES lists
    // first but which never actually ran).
    expect(steps.status.calls).toBe(1);
    expect(steps.status.bytes).toBe(independentByteSum(log, 4, 6));
    expect((steps.status as any).status).toBe("incomplete");
    expect((steps.status as any).reason).toMatch(/replay step crashed/);
    // Nothing past status ever ran.
    expect((steps.reconciliation as any).calls).toBe(0);
    expect((steps.reconciliation as any).status).toBe("incomplete");
    expect(steps.recap.calls).toBe(0);
    expect(calledTools).toEqual(["storybloq_session_guard", "storybloq_status"]);
  });

  it("recovers just the request's bytes (zero completed calls) when a call is sent but no response ever arrives", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      requestOnlyFailOnTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    expect((steps.reconciliation as any).verdict).toBe("matched");
    // The recap request was genuinely sent (real bytes) but no response
    // ever arrived -- that costs real bytes but is not a completed call.
    expect(steps.recap.bytes).toBeGreaterThan(0);
    expect(steps.recap.calls).toBe(0);
    expect((steps.recap as any).status).toBe("incomplete");
  });

  it("counts calls by matching JSON-RPC id, not by alternating direction -- a notification interleaved between a request and its reply is not mistaken for the reply", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      throwOnTool: "storybloq_lesson_digest",
      // recap's own request is followed by a stray notification (no id)
      // BEFORE recap's real response arrives. A direction-alternation-only
      // counter would treat that notification as recap's reply (counting
      // recap complete one message early) and then have nothing pending
      // when the real response lands.
      injectNotificationMidExchangeForTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // recap completed exactly once, matched to its OWN response by id, not
    // to the notification sitting between its request and reply.
    expect(steps.recap.calls).toBe(1);
    expect(steps.handover_latest.calls).toBe(1);
    expect((steps.lesson_digest as any).status).toBe("incomplete");
  });
});

// --- callTool resilience: a failing sub-call within a multi-call step must not
// erase the transport cost of exchanges that already completed, INCLUDING its
// own captured-but-unreadable exchange (not just prior successful ones). Both
// stepRecommend's issue_get loop and stepContinuationCheck's per-id walk make
// several sub-calls inside one step; a naive per-step try/catch (as opposed to
// per-sub-call) loses everything on the first failure. These tests build a
// response that is genuinely captured (request+response both logged, so the
// transport cost is real) but whose content cannot be read as text, forcing
// callTool's CallToolFailure path and proving its partialBytes/partialCalls
// actually reach the step's own report. -----------------------------------

function makeRecommendMarkdown(issueIds: readonly string[]): string {
  const lines = ["# Recommendations", ""];
  issueIds.forEach((id, i) => {
    lines.push(`${i + 1}. **${id}** (issue) -- Issue ${id}`);
    lines.push(`   _reason for ${id}_`);
    lines.push("");
  });
  return lines.join("\n");
}

describe("stepRecommend: retains prior + captured-but-unreadable sub-call costs", () => {
  it("stops at the first unreadable issue_get, keeping recommend's own cost, the prior successful issue_get, and the failing exchange's captured bytes", async () => {
    const log: CapturedMessage[] = [];
    let nextId = 1;
    const issueGetOrder: string[] = [];

    const pushExchange = (method: string, params: unknown, result: unknown): void => {
      const id = nextId++;
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
      log.push({ seq: log.length, direction: "server-to-client", message: { result, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === "storybloq_recommend") {
          pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: makeRecommendMarkdown(["ISS-1", "ISS-2", "ISS-3"]) }] });
          return undefined;
        }
        if (name === "storybloq_issue_get") {
          issueGetOrder.push(args.id as string);
          if (args.id === "ISS-2") {
            // Genuinely captured (request + response both logged, real
            // transport cost) but the content shape cannot be read as text.
            pushExchange("tools/call", { name, arguments: args }, { content: [] });
            return undefined;
          }
          pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: `# ${args.id}: an issue\n\nStatus: closed` }] });
          return undefined;
        }
        pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: "{}" }] });
        return undefined;
      },
    };

    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const { report, rows } = await stepRecommend(ctx);

    // The walk stops at ISS-2 and never reaches ISS-3.
    expect(issueGetOrder).toEqual(["ISS-1", "ISS-2"]);
    expect(rows).toHaveLength(3);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-2/);
    // calls: recommend (1) + issue_get ISS-1 (1, succeeded) + issue_get ISS-2
    // (1, captured but unreadable -- still a real completed exchange).
    expect(report.calls).toBe(3);
    // Exact byte retention, not a weak bound: independently sum every
    // request+response the log actually captured (recommend + ISS-1 +
    // ISS-2, but NOT ISS-3, which never fired) and require an exact match.
    // A mutant that drops only the failing exchange's bytes (while keeping
    // the call count) would pass a `> 0` check but fails this.
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
    // Only the genuinely-interpreted issue_get is counted in issueGetCalls;
    // the failing one's cost is folded into the overall bytes/calls instead.
    expect((report as any).issueGetCalls).toBe(1);
  });

  it("retains a request-only (no-response) failure's own bytes via CallToolFailure, not just captured-but-unreadable ones", async () => {
    const log: CapturedMessage[] = [];
    let nextId = 1;
    const issueGetOrder: string[] = [];

    const pushRequest = (method: string, params: unknown, id: number): void => {
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
    };
    const pushExchange = (method: string, params: unknown, result: unknown): void => {
      const id = nextId++;
      pushRequest(method, params, id);
      log.push({ seq: log.length, direction: "server-to-client", message: { result, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === "storybloq_recommend") {
          pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: makeRecommendMarkdown(["ISS-1", "ISS-2", "ISS-3"]) }] });
          return undefined;
        }
        if (name === "storybloq_issue_get") {
          issueGetOrder.push(args.id as string);
          if (args.id === "ISS-2") {
            // A request was genuinely sent (real bytes) but the call
            // rejects before any response is ever captured -- a dropped
            // connection, not a captured-but-unreadable response. This is
            // the path CallToolFailure's own no-response branch handles,
            // distinct from the generic runReplaySequence catch (that one
            // only recovers a step that has no LOCAL catch of its own;
            // this loop DOES catch CallToolFailure itself).
            pushRequest("tools/call", { name, arguments: args }, nextId++);
            throw new Error(`mock connection drop calling issue_get ${args.id}`);
          }
          pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: `# ${args.id}: an issue\n\nStatus: closed` }] });
          return undefined;
        }
        pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: "{}" }] });
        return undefined;
      },
    };

    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const { report, rows } = await stepRecommend(ctx);

    expect(issueGetOrder).toEqual(["ISS-1", "ISS-2"]);
    expect(rows).toHaveLength(3);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-2/);
    // calls: recommend (1) + issue_get ISS-1 (1, succeeded). ISS-2's request
    // was sent but never answered, so it costs real bytes but is not a
    // completed call.
    expect(report.calls).toBe(2);
    expect((report as any).issueGetCalls).toBe(1);
    // Exact retention: recommend + ISS-1's full exchange plus ISS-2's
    // dangling, unanswered request -- summed independently of the harness's
    // own measuredBytes pipeline.
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });
});

describe("stepContinuationCheck: retains prior + captured-but-unreadable walk costs", () => {
  it("stops at the first unreadable walk exchange, keeping the constructed section cost, the prior successful (non-clearing) lookup, and the failing exchange's captured bytes", async () => {
    const handoverBody = ["## Open items", "", "- ISS-100", "- ISS-200", "- ISS-300", ""].join("\n");

    const log: CapturedMessage[] = [];
    let nextId = 1;
    const walkOrder: string[] = [];

    const pushExchange = (method: string, params: unknown, result: unknown): void => {
      const id = nextId++;
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
      log.push({ seq: log.length, direction: "server-to-client", message: { result, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        walkOrder.push(args.id as string);
        if (args.id === "ISS-200") {
          pushExchange("tools/call", { name, arguments: args }, { content: [] });
          return undefined;
        }
        // ISS-100 is well-formed but does not clear the actionability bar,
        // so the walk continues past it to ISS-200.
        pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text: `# ${args.id}: an issue\n\nStatus: closed` }] });
        return undefined;
      },
    };

    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const { report } = await stepContinuationCheck(ctx, handoverBody);

    expect(walkOrder).toEqual(["ISS-100", "ISS-200"]);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-200/);
    // calls: ISS-100 (succeeded, did not clear) + ISS-200 (captured but
    // unreadable -- still a real completed exchange). The walk never reaches
    // ISS-300.
    expect(report.calls).toBe(2);
    expect((report as any).walkCalls).toBe(2);
    // Exact byte retention: constructed section text plus the independently
    // summed ISS-100 + ISS-200 exchanges (never ISS-300, which never
    // fired). A mutant dropping only the failing exchange's bytes would
    // still pass a `> constructedBytes` bound but fails this.
    expect(report.bytes).toBe((report as any).constructedBytes + independentByteSum(log, 0, log.length));
  });
});

// --- orchestrator gating (unit level; live-mode node_list step gate) -----------

describe("isOrchestratorConfig", () => {
  it("is false for a plain coding-project config, even one that happens to carry a nodes field", () => {
    expect(isOrchestratorConfig({ version: 2, project: "x", type: "coding" })).toBe(false);
    expect(isOrchestratorConfig({ type: "coding", nodes: { a: { path: "." } } })).toBe(false);
  });

  it("is true only when config.type is exactly 'orchestrator' -- the same gate project-loader.ts/tools.ts/recommend.ts use", () => {
    expect(isOrchestratorConfig({ type: "orchestrator" })).toBe(true);
  });

  it("is false for a non-object config", () => {
    expect(isOrchestratorConfig(null)).toBe(false);
    expect(isOrchestratorConfig(undefined)).toBe(false);
  });
});

// --- continuation section keyword (unit level: "blocked" is rendered, never promoted) ---

describe("findContinuationSection keyword", () => {
  it("reports keyword 'next' for a next-steps heading", () => {
    const body = ["# Handover", "", "## Next steps", "- T-1002", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("next");
  });

  it("reports keyword 'blocked' for a blocked-items heading, even if it also names an actionable entity", () => {
    const body = ["# Handover", "", "## Blocked items", "- T-1002 is blocked pending review", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("blocked");
  });

  it("reports keyword 'blocked' even when the SAME heading line also contains another actionable keyword", () => {
    // A greedy regex naively backtracks to the rightmost alternative match
    // ("remaining"), which would silently let a blocked section's entities
    // be promoted -- "blocked" must win regardless of word order.
    const body = ["# Handover", "", "## Blocked work remaining", "- T-1002", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("blocked");
  });
});

// --- fixture replay (end-to-end, real child process) ---------------------------

describe("fixture replay", () => {
  let fixtureDir: string;
  let report: PrimingCostReport;

  beforeAll(async () => {
    fixtureDir = await copyFixture();
    const result = await runEmitJson(fixtureDir);
    report = result.report;
  }, 60_000);

  afterAll(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("prints exactly one JSON object and nothing else on stdout", async () => {
    const { stdout } = await runEmitJson(fixtureDir);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("m1b: the full step-name inventory matches a fixed literal array declared here, in order", () => {
    // Declared independently of STEP_NAMES (not imported from the
    // implementation): a mutant that removes a step from both STEP_NAMES and
    // the report must still fail this check.
    expect(Object.keys(report.steps)).toEqual([
      "tool_discovery",
      "tool_discovery_reference",
      "session_guard",
      "reconciliation",
      "status",
      "recap",
      "handover_latest",
      "rules_md",
      "lesson_digest",
      "git_log",
      "recommend",
      "continuation_check",
      "context_column_lookup",
      "ready_to_work_table",
      "node_list",
    ]);
  });

  it("reports mode fixture and a complete (never observed_subtotal) total", () => {
    expect(report.mode).toBe("fixture");
    expect(report.totals.status).toBe("complete");
  });

  it("tool_discovery is modeled: zero calls, nonzero bytes, included in the total", () => {
    const step = report.steps.tool_discovery;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.includedInTotal).toBe(true);
  });

  it("tool_discovery_reference is a real call, excluded from the total", () => {
    const step = report.steps.tool_discovery_reference;
    expect(step.calls).toBe(1);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.includedInTotal).toBe(false);
  });

  it("session_guard: exactly one call", () => {
    expect(report.steps.session_guard.calls).toBe(1);
    expect(report.steps.session_guard.bytes).toBeGreaterThan(0);
    expect(report.steps.session_guard.bytes).toBeLessThan(5000);
  });

  it("reconciliation: zero calls, zero bytes, and the fingerprint comparison ran and matched", () => {
    const step = report.steps.reconciliation as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
    expect(step.matched).toBe(true);
    expect(step.verdict).toBe("matched");
    expect(step.mismatchedIds).toEqual([]);
  });

  it("status: exactly one call", () => {
    expect(report.steps.status.calls).toBe(1);
    expect(report.steps.status.bytes).toBeGreaterThan(0);
    expect(report.steps.status.bytes).toBeLessThan(10_000);
  });

  it("recap: exactly one call", () => {
    expect(report.steps.recap.calls).toBe(1);
  });

  it("handover_latest: one call, three body sub-rows, an overhead row, additive", () => {
    const step = report.steps.handover_latest as any;
    expect(step.calls).toBe(1);
    expect(step.bodyCount).toBe(3);
    expect(Array.isArray(step.bodies)).toBe(true);
    expect(step.bodies).toHaveLength(3);
    for (const b of step.bodies) expect(b).toBeGreaterThan(0);
    // handoverFilenames (and therefore these bodies) are ordered newest
    // first: bodies[0] is "latest" (largest), bodies[2] is "kickoff" (smallest).
    expect(step.bodies[2]).toBeLessThan(step.bodies[1]);
    expect(step.bodies[1]).toBeLessThan(step.bodies[0]);
    const sum = step.bodies.reduce((a: number, b: number) => a + b, 0);
    expect(sum + step.overheadBytes).toBe(step.bytes);
  });

  it("handover_latest: each body and the overhead row stay within its own pinned ceiling", () => {
    // Identified by fixture handover (bodies[0]=latest/SENTINEL-C,
    // bodies[1]=progress/SENTINEL-B, bodies[2]=kickoff/SENTINEL-A), not just
    // the aggregate -- one body growing while another shrinks by the same
    // amount would pass the aggregate ceiling alone.
    const step = report.steps.handover_latest as any;
    const bodyCeilings = [2000, 1200, 600]; // [latest, progress, kickoff]
    const table = step.bodies
      .map((b: number, i: number) => `body[${i}]=${b} (ceiling ${bodyCeilings[i]})`)
      .join(", ");
    for (let i = 0; i < bodyCeilings.length; i++) {
      if (step.bodies[i] > bodyCeilings[i]) {
        throw new Error(`handover body[${i}] exceeds its pinned ceiling. ${table}`);
      }
    }
    if (step.overheadBytes > 400) {
      throw new Error(`handover overheadBytes ${step.overheadBytes} exceeds its pinned 400 ceiling. ${table}`);
    }
  });

  it("rules_md: zero calls, a direct read", () => {
    expect(report.steps.rules_md.calls).toBe(0);
    expect(report.steps.rules_md.bytes).toBeGreaterThan(0);
  });

  it("rules_md: bytes equal the raw UTF-8 byte length of the file on disk, with NO JSON-string-escaping overhead", async () => {
    // Reads RULES.md independently (a fresh fs.readFile, not through the
    // harness) so this catches a regression that routes direct-read bytes
    // through the JSON-message byte contract (measuredBytes) instead of the
    // raw-text one (measuredTextBytes) -- that would inflate the count by at
    // least the 2 wrapping-quote bytes, plus 1 byte per escaped newline.
    const rawContent = await readFile(join(fixtureDir, "RULES.md"), "utf-8");
    expect(report.steps.rules_md.bytes).toBe(byteLength(rawContent));
  });

  it("lesson_digest: exactly one call", () => {
    expect(report.steps.lesson_digest.calls).toBe(1);
  });

  it("git_log: zero calls, the fixed literal", () => {
    expect(report.steps.git_log.calls).toBe(0);
    expect(report.steps.git_log.bytes).toBeGreaterThan(0);
  });

  it("git_log: bytes equal the raw UTF-8 byte length of the fixed literal declared independently here", () => {
    const expectedText = [
      "9f258c50 fix(bus): ISS-1162 bind park byEndpoint to thread participants",
      "eb8765ed docs(story): pen restart checkpoint 2",
      "71dead0a docs(story): pen handover addendum",
      "2df7d1f9 docs(story): ISS-1177 implementation shipped",
      "2dbfcfcb fix(app): ISS-1177 release background project window view trees",
      "49a8b2c2 docs(story): file the /story priming efficiency plan",
      "a1b2c3d4 fix(core): tighten earmark staleness threshold validation",
      "b2c3d4e5 feat(cli): add storybloq reconcile --ci flag",
      "c3d4e5f6 test(bus): cover redeliver refusal on unverified predecessor",
      "d4e5f6a7 chore(release): bump package version",
    ].join("\n");
    expect(report.steps.git_log.bytes).toBe(byteLength(expectedText));
  });

  it("recommend: request carries count 10, Gate B fetched all 3 open issues, and exactly 2 clear the actionability bar", () => {
    const step = report.steps.recommend as any;
    expect(step.requestCarriesCountTen).toBe(true);
    expect(step.issueGetCalls).toBe(3);
    expect(step.calls).toBe(1 + 3);
    // ISS-2001 (open, high, no marker) and ISS-2002 (open, medium, no marker)
    // clear; ISS-2003 (open, low, "OWNER-GATED" in impact) does not.
    expect(step.actionableIssueCount).toBe(2);
  });

  it("continuation_check: resolves T-1002 via exactly one ticket_get, with both sub-costs present", () => {
    const step = report.steps.continuation_check as any;
    expect(step.present).toBe(true);
    expect(step.resolvedId).toBe("T-1002");
    expect(step.walkCalls).toBe(1);
    expect(step.calls).toBe(1);
    expect(step.constructedBytes).toBeGreaterThan(0);
    expect(step.bytes).toBeGreaterThan(step.constructedBytes);
    // constructedBytes must be the raw-text byte count of the constructed
    // block, not its JSON-message-escaped size.
    expect(step.constructedBytes).toBe(byteLength(step.constructedText));
  });

  it("context_column_lookup: zero cost, n/a plus a diagnostic for every one of the 7 candidates", () => {
    const step = report.steps.context_column_lookup as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
    expect(step.rows).toHaveLength(7);
    for (const row of step.rows) {
      expect(row.context).toBe("n/a");
      expect(typeof row.diagnostic).toBe("string");
      expect(row.diagnostic.length).toBeGreaterThan(0);
    }
  });

  it("ready_to_work_table: zero calls, constructed text, and shows the (+2 more) suffix", () => {
    const step = report.steps.ready_to_work_table as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.rowsShown).toBe(5);
    expect(step.moreCount).toBe(2);
    expect(step.text).toContain("(+2 more)");
    // bytes must be the raw-text byte count of the table, not its
    // JSON-message-escaped size.
    expect(step.bytes).toBe(byteLength(step.text));
  });

  it("node_list: gated off (zero cost) for the fixture's non-orchestrator config", () => {
    const step = report.steps.node_list as any;
    expect(step.gated).toBe(true);
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
  });

  it("totals: sum exactly the steps marked includedInTotal", () => {
    let expectedBytes = 0;
    let expectedCalls = 0;
    for (const name of STEP_NAMES) {
      const step = report.steps[name] as any;
      if (step.includedInTotal) {
        expectedBytes += step.bytes;
        expectedCalls += step.calls;
      }
    }
    expect(report.totals.bytes).toBe(expectedBytes);
    expect(report.totals.calls).toBe(expectedCalls);
  });

  it("meta.measuredRoot is normalized to the fixed placeholder regardless of the real root", () => {
    expect(report.meta.measuredRoot).toBe(FIXTURE_ROOT_PLACEHOLDER);
  });

  // --- m1a: raw-log-derived tool-call sequence (independent of the harness's own summary) ---

  it("m1a: the raw log's tools/call name sequence is exactly the fixed literal array", () => {
    const calls = report.rawLog
      .filter((e) => e.direction === "client-to-server")
      .map((e) => e.message as any)
      .filter((m) => m.method === "tools/call")
      .map((m) => m.params.name as string);

    expect(calls).toEqual([
      "storybloq_session_guard",
      "storybloq_status",
      "storybloq_recap",
      "storybloq_handover_latest",
      "storybloq_lesson_digest",
      "storybloq_recommend",
      "storybloq_issue_get",
      "storybloq_issue_get",
      "storybloq_issue_get",
      "storybloq_ticket_get",
    ]);
  });

  // --- m2: independently re-derived issue_get count, cross-checked against the harness's own field ---

  it("m2: raw-log issue_get count matches the harness's own reported issueGetCalls field", () => {
    const rawCount = report.rawLog.filter(
      (e) =>
        e.direction === "client-to-server" &&
        (e.message as any).method === "tools/call" &&
        (e.message as any).params?.name === "storybloq_issue_get",
    ).length;
    expect(rawCount).toBe(3);
    expect((report.steps.recommend as any).issueGetCalls).toBe(rawCount);
  });

  // --- m3 corroboration: recompute the multibyte-title exchange's bytes directly from the raw log ---

  it("m3 corroboration: independently summing recommend + all 3 issue_get exchanges from the raw log matches the harness's own reported recommend.bytes", () => {
    const entries = report.rawLog;
    const normalize = buildNormalizer(fixtureDir);

    function exchangeBytes(toolName: string, matchArgs?: (args: any) => boolean): number {
      for (let i = 0; i < entries.length; i++) {
        const msg = entries[i]!.message as any;
        if (
          entries[i]!.direction === "client-to-server" &&
          msg.method === "tools/call" &&
          msg.params?.name === toolName &&
          (!matchArgs || matchArgs(msg.params?.arguments))
        ) {
          const res = entries.slice(i + 1).find(
            (e) => e.direction === "server-to-client" && (e.message as any).id === msg.id,
          );
          if (!res) continue;
          // Buffer.byteLength directly -- NOT the imported byteLength -- so a
          // mutation of the harness's own byteLength helper cannot silently
          // move both sides of this comparison together.
          return (
            Buffer.byteLength(JSON.stringify(normalize(msg)), "utf8") +
            Buffer.byteLength(JSON.stringify(normalize(res.message)), "utf8")
          );
        }
      }
      throw new Error(`exchangeBytes: no ${toolName} exchange found`);
    }

    const recommendBytes = exchangeBytes("storybloq_recommend");
    const issueBytes = ["ISS-2001", "ISS-2002", "ISS-2003"].reduce(
      (sum, id) => sum + exchangeBytes("storybloq_issue_get", (args) => args?.id === id),
      0,
    );
    const independentTotal = recommendBytes + issueBytes;

    expect(independentTotal).toBe((report.steps.recommend as any).bytes);

    // Corroborates the multibyte title specifically: a UTF-16-length-based
    // (buggy) measurement of the ISS-2002 exchange would be strictly smaller
    // than its true UTF-8 byte count.
    const iss2002Bytes = exchangeBytes("storybloq_issue_get", (args) => args?.id === "ISS-2002");
    let rawText = "";
    for (const e of entries) {
      const msg = e.message as any;
      if (e.direction === "server-to-client" && typeof msg.result?.content?.[0]?.text === "string") {
        if (msg.result.content[0].text.includes("café")) {
          rawText = msg.result.content[0].text;
          break;
        }
      }
    }
    expect(rawText).not.toBe("");
    expect(byteLength(rawText)).toBeGreaterThan(rawText.length);
    expect(iss2002Bytes).toBeGreaterThan(0);
  });

  // Pinned per-step byte ceilings and exact call counts (T-497's own stated
  // deliverable). Ceilings carry headroom above the observed value so a
  // small, legitimate future content change doesn't flap the gate; call
  // counts are exact since they are deterministic on this frozen corpus.
  // tool_discovery_reference is excluded: it is informational
  // (includedInTotal: false) and its size tracks the live tool count, not
  // this ticket's corpus.
  const STEP_CEILINGS: Record<string, { maxBytes: number; calls: number }> = {
    tool_discovery: { maxBytes: 3000, calls: 0 },
    session_guard: { maxBytes: 1500, calls: 1 },
    reconciliation: { maxBytes: 0, calls: 0 },
    status: { maxBytes: 6000, calls: 1 },
    recap: { maxBytes: 2500, calls: 1 },
    handover_latest: { maxBytes: 4000, calls: 1 },
    rules_md: { maxBytes: 600, calls: 0 },
    lesson_digest: { maxBytes: 500, calls: 1 },
    git_log: { maxBytes: 900, calls: 0 },
    recommend: { maxBytes: 4000, calls: 4 },
    continuation_check: { maxBytes: 1500, calls: 1 },
    context_column_lookup: { maxBytes: 0, calls: 0 },
    ready_to_work_table: { maxBytes: 1500, calls: 0 },
    node_list: { maxBytes: 0, calls: 0 },
  };

  it("every counted step stays within its pinned byte ceiling and exact call count", () => {
    const failures: string[] = [];
    const table: string[] = [];
    for (const [name, ceiling] of Object.entries(STEP_CEILINGS)) {
      const step = (report.steps as any)[name];
      table.push(
        `${name}: bytes=${step.bytes} (ceiling ${ceiling.maxBytes}), calls=${step.calls} (expected ${ceiling.calls})`,
      );
      if (step.bytes > ceiling.maxBytes) {
        failures.push(`${name}: bytes ${step.bytes} exceeds ceiling ${ceiling.maxBytes}`);
      }
      if (step.calls !== ceiling.calls) {
        failures.push(`${name}: calls ${step.calls} !== expected ${ceiling.calls}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.join("\n")}\n\nFull measurement table:\n${table.join("\n")}`);
    }
  });

  it("total bytes stay within a pinned ceiling and total calls equal exactly 10", () => {
    expect(report.totals.calls).toBe(10);
    if (report.totals.bytes > 20_000) {
      throw new Error(
        `totals.bytes ${report.totals.bytes} exceeds the pinned 20000 ceiling; ` +
          `per-step: ${JSON.stringify(
            Object.fromEntries(Object.entries(report.steps).map(([k, v]: [string, any]) => [k, v.bytes])),
          )}`,
      );
    }
  });
});

// --- continuation walk suppresses promotion for a blocked-keyword heading (end-to-end) ---

describe("continuation walk suppresses promotion for a blocked-keyword heading", () => {
  it("renders the blocked section but performs zero walk calls and resolves nothing", async () => {
    const dir = await copyFixture();
    try {
      // A newer handover (dated after the existing 3) whose only actionable-
      // heading match is "blocked", naming T-1002 -- independently known
      // actionable via the main fixture replay above. Promotion must not
      // happen even though T-1002 itself would clear the actionability bar.
      await writeFile(
        join(dir, ".story", "handovers", "2026-09-05-blocked-check.md"),
        [
          "SENTINEL-D-blocked-check",
          "# Session Handover - Blocked Check",
          "",
          "**Date:** 2026-09-05",
          "",
          "## Blocked items",
          "- T-1002 is mentioned here but this section describes BLOCKED work, not a promotion target.",
          "",
          "## Notes",
          "- nothing else.",
        ].join("\n"),
        "utf-8",
      );

      const { report } = await runEmitJson(dir);
      const step = report.steps.continuation_check as any;
      expect(step.present).toBe(true);
      expect(step.resolvedId).toBeNull();
      expect(step.walkCalls).toBe(0);
      expect(step.calls).toBe(0);
      expect(step.constructedBytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- m4 end-to-end: two different-length fixture roots, identical reported bytes -----------

// m4 (compute bytes before normalization) is INERT on this fixture: no real
// step response embeds the fixture root for a clean, guard-free (zero
// session) corpus -- see the file-level comment above for the full 3-step
// check the pen asked for. This test remains a genuine structural-equality
// regression check (reported counts must not depend on incidental root
// length even where nothing here currently leaks it) but is not claimed as
// an m4 mutant kill; `buildNormalizer`'s own unit tests above are the actual
// correctness proof for the normalization logic.
describe("temp-root length independence (structural equality check; m4 is inert on this corpus)", () => {
  it("reported per-step byte counts and totals are identical across differently-sized fixture roots", async () => {
    const shortParent = await mkdtemp(join(tmpdir(), "pc-s-"));
    const longParentBase = await mkdtemp(join(tmpdir(), "pc-l-"));
    const longParent = join(
      longParentBase,
      "a-deliberately-much-longer-nested-directory-segment-to-change-the-root-length",
    );
    await mkdir(longParent, { recursive: true });

    const shortDir = await copyFixture(join(shortParent, "fx"));
    const longDir = await copyFixture(join(longParent, "fx"));
    await mkdir(shortDir, { recursive: true }).catch(() => {});

    try {
      const [a, b] = await Promise.all([runEmitJson(shortDir), runEmitJson(longDir)]);
      expect(shortDir.length).not.toBe(longDir.length);

      for (const name of STEP_NAMES) {
        expect(a.report.steps[name].bytes).toBe(b.report.steps[name].bytes);
        expect(a.report.steps[name].calls).toBe(b.report.steps[name].calls);
      }
      expect(a.report.totals.bytes).toBe(b.report.totals.bytes);
      expect(a.report.totals.calls).toBe(b.report.totals.calls);
      expect(a.report.meta.measuredRoot).toBe(b.report.meta.measuredRoot);
    } finally {
      await rm(shortParent, { recursive: true, force: true });
      await rm(longParentBase, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- byte-identical-across-two-runs (full normalized transcript) ---------------------------

function buildNormalizedTranscript(report: PrimingCostReport, root: string): string {
  const normalize = buildNormalizer(root);
  const transcript: unknown[] = [];
  for (const entry of report.rawLog) {
    transcript.push(normalize(entry.message));
  }
  transcript.push(normalize({ measuredRoot: report.meta.measuredRoot }));
  // Content-bearing steps that are NOT reflected in rawLog at all (direct
  // reads, fixed literals, modeled/synthetic requests, constructed text) --
  // the transcript must cover them too, or an equal-length content swap in
  // any of them would change nothing this hash can see.
  const discovery = report.steps.tool_discovery as any;
  const rulesMd = report.steps.rules_md as any;
  const gitLog = report.steps.git_log as any;
  const continuation = report.steps.continuation_check as any;
  const readyTable = report.steps.ready_to_work_table as any;
  transcript.push(normalize({ modeledDiscoveryRequest: discovery.modeledRequest ?? null }));
  transcript.push(normalize({ modeledDiscoveryResponse: discovery.modeledResponse ?? null }));
  transcript.push(normalize({ rulesMdContent: rulesMd.content ?? null }));
  transcript.push(normalize({ gitLogContent: gitLog.content ?? null }));
  transcript.push(normalize({ continuationConstructedText: continuation.constructedText ?? null }));
  transcript.push(normalize({ readyToWorkTableText: readyTable.text ?? null }));
  return JSON.stringify(transcript);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("determinism: two runs against fresh fixture copies are byte-identical", () => {
  it("produces an identical complete normalized transcript across two independent runs", async () => {
    const dirA = await copyFixture();
    const dirB = await copyFixture();
    try {
      const [a, b] = await Promise.all([runEmitJson(dirA), runEmitJson(dirB)]);
      const transcriptA = buildNormalizedTranscript(a.report, dirA);
      const transcriptB = buildNormalizedTranscript(b.report, dirB);
      expect(sha256(transcriptA)).toBe(sha256(transcriptB));

      for (const name of STEP_NAMES) {
        expect(a.report.steps[name].bytes).toBe(b.report.steps[name].bytes);
      }
      expect(a.report.totals.bytes).toBe(b.report.totals.bytes);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  }, 60_000);

  it("an equal-length content change in a constructed/direct-read step changes the transcript hash", () => {
    const root = "/tmp/whatever-root";
    const makeReport = (rulesMdContent: string): PrimingCostReport => ({
      mode: "fixture",
      meta: { measuredRoot: FIXTURE_ROOT_PLACEHOLDER, generatedAt: "x" },
      steps: {
        tool_discovery: { bytes: 0, calls: 0, includedInTotal: true, modeledRequest: {}, modeledResponse: {} },
        tool_discovery_reference: { bytes: 0, calls: 0, includedInTotal: false },
        session_guard: { bytes: 0, calls: 0, includedInTotal: true },
        reconciliation: { bytes: 0, calls: 0, includedInTotal: true },
        status: { bytes: 0, calls: 0, includedInTotal: true },
        recap: { bytes: 0, calls: 0, includedInTotal: true },
        handover_latest: { bytes: 0, calls: 0, includedInTotal: true },
        rules_md: { bytes: 0, calls: 0, includedInTotal: true, content: rulesMdContent },
        lesson_digest: { bytes: 0, calls: 0, includedInTotal: true },
        git_log: { bytes: 0, calls: 0, includedInTotal: true, content: "x" },
        recommend: { bytes: 0, calls: 0, includedInTotal: true },
        continuation_check: { bytes: 0, calls: 0, includedInTotal: true, constructedText: "x" },
        context_column_lookup: { bytes: 0, calls: 0, includedInTotal: true },
        ready_to_work_table: { bytes: 0, calls: 0, includedInTotal: true, text: "x" },
        node_list: { bytes: 0, calls: 0, includedInTotal: true },
      } as any,
      totals: { bytes: 0, calls: 0, status: "complete" },
      rawLog: [],
    });

    const transcriptA = buildNormalizedTranscript(makeReport("AAAA"), root);
    const transcriptB = buildNormalizedTranscript(makeReport("BBBB"), root); // same length, different content
    expect(transcriptA).not.toBe(transcriptB);
    expect(sha256(transcriptA)).not.toBe(sha256(transcriptB));
  });
});

// --- live mode: genuinely-empty recommend result vs. a synthetic parse failure ------
//
// storybloq_recommend's real output space is closed: reading
// formatRecommendations's source shows it is always either the numbered-list
// shape or one of 3 fixed "no recommendations" strings -- there is no way to
// coax the real tool into returning a THIRD shape that would make
// deriveRecommendRows report parseFailed:true. So the "retain captured bytes
// on parse failure" behaviour is proven at the unit level, directly against
// buildFailedRecommendReport with a synthetic measurement, where the failure
// path is actually reachable; the end-to-end test below instead exercises
// the real, reachable case: a live project with zero real candidates.

describe("live mode: zero real candidates (well-formed, not a parse failure)", () => {
  it("reports totals.status complete, recommend still transmitted, and zero issue_get calls when the project has no tickets or issues", async () => {
    const liveDir = await mkdtemp(join(tmpdir(), "pc-live-"));
    try {
      await cp(FIXTURE_SRC, liveDir, { recursive: true });
      // The real ledger lives under .story/, not at the project root.
      await rm(join(liveDir, ".story", "tickets"), { recursive: true, force: true });
      await rm(join(liveDir, ".story", "issues"), { recursive: true, force: true });
      await mkdir(join(liveDir, ".story", "tickets"));
      await mkdir(join(liveDir, ".story", "issues"));

      const { env, cleanup } = await makeIsolatedEnv();
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", liveDir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);

        // A zero-candidate result is a legitimate, well-formed response (one
        // of the 3 known "no recommendations" strings), never a parse
        // failure -- recommend itself is never marked incomplete (this
        // fixture copy has no .git directory, so totals.status can still be
        // "observed_subtotal" for the unrelated git_log step; that is not
        // what this test is about).
        expect((report.steps.recommend as any).status).toBeUndefined();
        expect(report.steps.recommend.calls).toBe(1);
        expect(report.steps.recommend.bytes).toBeGreaterThan(0);
        expect((report.steps.recommend as any).issueGetCalls).toBe(0);
        expect((report.steps.recommend as any).actionableIssueCount).toBe(0);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(liveDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("live mode meta: commit, dirty state, session inventory, installed-skill hash, orchestrator flag", () => {
  it("reports a real commit hash, dirty=false, an empty session inventory, and orchestrator=false for a clean non-orchestrator project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-meta-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const { env, cleanup } = await makeIsolatedEnv();
      try {
        await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
        await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
        await execFileAsync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
          { cwd: dir, env },
        );

        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);

        expect(typeof report.meta.commit).toBe("string");
        expect(report.meta.commit).toHaveLength(40);
        expect(report.meta.dirty).toBe(false);
        expect(report.meta.orchestrator).toBe(false);
        expect(report.meta.sessionInventory).toEqual({ count: 0, ids: [] });
        expect(
          report.meta.installedSkillHash === null || typeof report.meta.installedSkillHash === "string",
        ).toBe(true);
        expect((report.steps.node_list as any).gated).toBe(true);
        expect(report.steps.node_list.calls).toBe(0);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports dirty=true when the live project has an uncommitted change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-dirty-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const { env, cleanup } = await makeIsolatedEnv();
      try {
        await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
        await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
        await execFileAsync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
          { cwd: dir, env },
        );
        await writeFile(join(dir, "RULES.md"), "changed\n", "utf-8");

        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);
        expect(report.meta.dirty).toBe(true);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports orchestrator=true and does not gate off node_list when config.type is 'orchestrator'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-orch-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const configPath = join(dir, ".story", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      config.type = "orchestrator";
      config.nodes = { root: { path: ".", role: "orchestrator root" } };
      await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

      const { env, cleanup } = await makeIsolatedEnv();
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);
        expect(report.meta.orchestrator).toBe(true);
        expect((report.steps.node_list as any).gated).toBe(false);
        expect(report.steps.node_list.calls).toBe(1);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("buildCrashReport (unit level: the live tools already degrade gracefully in every real scenario tried, so this safety net's own end-to-end trigger could not be reproduced against the real MCP server -- proven directly instead, honestly, rather than claiming an unreproduced end-to-end kill)", () => {
  it("produces a minimally-shaped, fully-incomplete report that never throws when serialized", () => {
    const report = buildCrashReport("/some/root", new Error("boom"));
    expect(report.mode).toBe("live");
    expect(report.totals.status).toBe("observed_subtotal");
    expect(report.totals.bytes).toBe(0);
    expect(report.totals.calls).toBe(0);
    expect(Object.keys(report.steps)).toEqual([...STEP_NAMES]);
    for (const name of STEP_NAMES) {
      const step = report.steps[name] as any;
      expect(step.status).toBe("incomplete");
      expect(step.reason).toContain("boom");
    }
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});

describe("buildFailedRecommendReport (unit level: the real tool cannot produce this shape, so this is the only place the retention behaviour is reachable)", () => {
  it("retains the synthetic measurement's exact bytes and call count, and reports status incomplete", () => {
    const measurement: ExchangeMeasurement = {
      requestBytes: 40,
      responseBytes: 123,
      totalBytes: 163,
      calls: 1,
      rawRequest: { params: { arguments: { count: 10 } } },
      rawResponse: {},
    };
    const report = buildFailedRecommendReport(measurement, "response matched neither known shape");
    expect(report.bytes).toBe(163);
    expect(report.calls).toBe(1);
    expect(report.includedInTotal).toBe(true);
    expect(report.status).toBe("incomplete");
    expect(report.issueGetCalls).toBe(0);
    expect(report.actionableIssueCount).toBe(0);
    expect(report.requestCarriesCountTen).toBe(true);
  });
});
