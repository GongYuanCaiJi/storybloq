/**
 * T-507: the seat roster Mod. Keeps `.story/telemetry/roster/` current for
 * this session and its subagents, through the storybloq CLI and nothing else.
 *
 * WHAT A SEAT IS. This session (`client:clientTaskId`) and every subagent it
 * spawns (`client:clientTaskId/agentId`). The client task id is the client's
 * own session id (CLAUDE_CODE_SESSION_ID, `$.session.id()` when unset), the
 * same key presence and the Bus use, so a seat restart under a new session id
 * updates the row rather than duplicating it (ISS-1205).
 *
 * WHERE THE EVENTS COME FROM. `session.start` seats the session; `agent.spawn`
 * seats a child once `next(e)` has started it and named it; a child's own
 * `turn.complete` ends it (its answer IS its end: the client has no agent
 * finish event); `session.detach` ends every child and then the session
 * seat, detached, and seats no child after it. There is
 * no kill or failure event either, so a 60 second poll of `$.agent.list()`
 * ends a child the list reports killed, failed or completed and does nothing
 * on any other answer (absent, running, unknown).
 *
 * THE WRITER. One serialized queue: a start or an end is an ordered barrier
 * (a child's end never overtakes its start), a heartbeat coalesces with one
 * already waiting for the same seat. Lifecycle writes are awaited, bounded
 * by the CLI call's own timeout; `tool.call` heartbeats are never awaited
 * and never block a tool, and fire at most once per seat per five minutes.
 *
 * WHEN IT STOPS. `no_project` from the CLI is cached per cwd and no further
 * write is attempted there; a failing CLI (a non-zero exit that is not a
 * refusal, or a process that cannot start) is logged once and backed off
 * for a minute, then tried again on the next event; a session start that
 * failed that way is retried by the poll timer once the minute has passed.
 *
 * EVENT NAMES AND `$`. Literals at every `on()` and `$.noun.member(...)`
 * inline, as the client's source scan requires; `client-api.ts` is the pin.
 * `$` is only ever handed to top-level functions of this file.
 */

import type { On } from "./mod.js";
import { resolveStorybloqBin } from "./install.js";

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** The floor between two heartbeats for one seat. */
export const HEARTBEAT_MS = 5 * 60_000;
/** How often `$.agent.list()` is asked about running children. */
export const POLL_MS = 60_000;
/** How long a failing CLI is left alone. */
export const BACKOFF_MS = 60_000;
/** The CLI call's ceiling; it bounds every awaited write. */
export const CLI_TIMEOUT_MS = 5_000;

type TerminalState = "completed" | "failed" | "killed" | "detached";

interface Seat {
  readonly agentId: string | null;
  generation: number;
  ended: boolean;
}

interface CliAnswer {
  readonly ok: boolean;
  readonly code: string | null;
  readonly data: Record<string, unknown> | null;
  readonly message: string;
}

/** Everything the Mod remembers for the session; module scope, reset at register. */
let cwd = "";
let clientTaskId = "";
let session: Seat | null = null;
let children: Record<string, Seat> = {};
let noProject: Record<string, true> = {};
let lastBeat: Record<string, number> = {};
let beatPending: Record<string, true> = {};
let tail: Promise<unknown> = Promise.resolve();
let backoffUntil = 0;
let saidFailure = false;
let pollStarted = false;
let polling = false;
/** The session asked for its seat and has not yet got it: the timer retries after a backoff. */
let sessionWanted = false;
/** Set synchronously when `session.detach` arrives: no child is seated after it. */
let detaching = false;

function forgetEverything(): void {
  cwd = "";
  clientTaskId = "";
  session = null;
  children = {};
  noProject = {};
  lastBeat = {};
  beatPending = {};
  tail = Promise.resolve();
  backoffUntil = 0;
  saidFailure = false;
  pollStarted = false;
  polling = false;
  sessionWanted = false;
  detaching = false;
}

function seatKey(agentId: string | null): string {
  return agentId === null ? clientTaskId : `${clientTaskId}/${agentId}`;
}

/** One CLI call, one parsed envelope; a process that cannot start is a failure answer, never a throw. */
async function runCli($: any, verb: "start" | "heartbeat" | "end", body: Record<string, unknown>): Promise<CliAnswer> {
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await $.process.run([resolveStorybloqBin(), "roster", verb, "--stdin", "--format", "json"], {
      cwd,
      stdin: JSON.stringify(body),
      timeoutMs: CLI_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, code: null, data: null, message: err instanceof Error ? err.message : String(err) };
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, code: null, data: null, message: `roster ${verb}: no JSON envelope (exit ${result.exitCode})` };
  }
  if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error.code === "string") {
    return { ok: false, code: parsed.error.code, data: null, message: String(parsed.error.message ?? parsed.error.code) };
  }
  if (result.exitCode !== 0 || !parsed || typeof parsed !== "object" || !parsed.data) {
    return { ok: false, code: null, data: null, message: `roster ${verb}: exit ${result.exitCode}` };
  }
  return { ok: true, code: null, data: parsed.data as Record<string, unknown>, message: "" };
}

/** Whether a write may be attempted now: a ledger under this cwd, no backoff in force. */
async function writable($: any): Promise<boolean> {
  if (cwd === "" || noProject[cwd] === true) return false;
  if (backoffUntil === 0) return true;
  const now: number = await $.clock.now();
  return now >= backoffUntil;
}

/** Records what a failed answer means for later writes. */
async function noteFailure($: any, answer: CliAnswer): Promise<void> {
  if (answer.code === "no_project") {
    noProject[cwd] = true;
    return;
  }
  // A refusal is the ledger's answer about this seat (a stale generation
  // after a restart, say), not a broken CLI: it is not backed off.
  if (answer.code === "refused_transition" || answer.code === "invalid_input") return;
  const now: number = await $.clock.now();
  backoffUntil = now + BACKOFF_MS;
  if (!saidFailure) {
    saidFailure = true;
    $.ui.log(`storybloq roster: ${answer.message}; the roster is left as it is for a minute`);
  }
}

/** Appends to the serialized writer and returns the write's own promise. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Seats a session or a child: `start`, an ordered barrier. */
function startSeat($: any, agentId: string | null, description: string | null): Promise<void> {
  return enqueue(async () => {
    // A child asked for while the session has no seat, or after its seat
    // ended, is not seated: nothing would end it. A child start queued
    // before the detach still runs, and the detach barrier ends it.
    if (agentId !== null && (session === null || session.ended)) return;
    if (agentId === null && session !== null && !session.ended) return;
    if (!(await writable($))) return;
    const body: Record<string, unknown> = { clientTaskId, sessionId: clientTaskId, description };
    if (agentId !== null) body["agentId"] = agentId;
    const answer = await runCli($, "start", body);
    if (!answer.ok) {
      await noteFailure($, answer);
      return;
    }
    const generation = typeof answer.data?.["generation"] === "number" ? (answer.data["generation"] as number) : 1;
    const seat: Seat = { agentId, generation, ended: false };
    if (agentId === null) {
      session = seat;
      sessionWanted = false;
    } else {
      children[agentId] = seat;
    }
    const now: number = await $.clock.now();
    lastBeat[seatKey(agentId)] = now;
  });
}

/** Ends a seat: `end`, an ordered barrier; a seat never started or already ended is left alone. */
function endSeat($: any, agentId: string | null, state: TerminalState): Promise<void> {
  return enqueue(async () => {
    const seat = agentId === null ? session : children[agentId];
    if (!seat || seat.ended) return;
    if (!(await writable($))) return;
    const body: Record<string, unknown> = { clientTaskId, generation: seat.generation, state };
    if (agentId !== null) body["agentId"] = agentId;
    const answer = await runCli($, "end", body);
    if (!answer.ok) {
      await noteFailure($, answer);
      // A refused transition means the ledger already holds a later
      // generation or a terminal state for this seat: it is ended for us.
      if (answer.code !== "refused_transition") return;
    }
    seat.ended = true;
    if (agentId !== null) delete children[agentId];
  });
}

/**
 * Refreshes a seat's lastSeenAt, at most once per HEARTBEAT_MS, one waiting
 * per seat. Never awaited by a tool.call hook.
 */
async function heartbeat($: any, agentId: string | null): Promise<void> {
  const seat = agentId === null ? session : children[agentId ?? ""];
  if (!seat || seat.ended) return;
  const key = seatKey(agentId);
  if (beatPending[key] === true) return;
  // The flag is taken BEFORE the first await and held until the write has
  // LANDED: two beats asked for in the same tick fold into one, and a beat
  // asked for while one is in flight folds into it rather than queueing.
  beatPending[key] = true;
  try {
    const now: number = await $.clock.now();
    const last = lastBeat[key];
    if (last !== undefined && now - last < HEARTBEAT_MS) return;
    await enqueue(async () => {
      if (seat.ended || !(await writable($))) return;
      const body: Record<string, unknown> = { clientTaskId, generation: seat.generation };
      if (agentId !== null) body["agentId"] = agentId;
      const answer = await runCli($, "heartbeat", body);
      if (!answer.ok) {
        await noteFailure($, answer);
        return;
      }
      lastBeat[key] = await $.clock.now();
    });
  } finally {
    delete beatPending[key];
  }
}

/** Ends a child whose loop the client reports as over; every other answer leaves it alone. */
function stateFromStatus(status: unknown): TerminalState | null {
  if (status === "completed" || status === "failed" || status === "killed") return status;
  return null;
}

/**
 * The poll: retries a session start the CLI failed transiently (after the
 * backoff has passed), then ends children whose status `$.agent.list()`
 * reports as terminal.
 */
async function poll($: any): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    if (sessionWanted && session === null && !detaching) {
      await startSeat($, null, null);
    }
    const ids = Object.keys(children);
    if (ids.length === 0) return;
    const list: { id: string; status: string }[] = await $.agent.list();
    for (const id of ids) {
      const info = list.find((agent) => agent.id === id);
      const state = info ? stateFromStatus(info.status) : null;
      if (state !== null) await endSeat($, id, state);
    }
  } catch {
    // The list is best-effort; the next period asks again.
  } finally {
    polling = false;
  }
}

function startPoll($: any): void {
  if (pollStarted) return;
  try {
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => {});
    });
  } catch {
    // A hook beneath may refuse the registration; the next session.start asks again.
    return;
  }
  pollStarted = true;
}

function stateFromReason(reason: unknown): TerminalState {
  if (reason === "error" || reason === "refusal") return "failed";
  if (reason === "aborted") return "killed";
  return "completed";
}

/** `registerRoster(on, options)`: every event name a literal, `$` only handed to the functions above. */
export function registerRoster(on: On, _options: Options): void {
  forgetEverything();

  // `/^/` matches every string, the empty cwd included: the matcher is
  // there for the scan's duplicate-registration rule, not to filter.
  on("session.start", { cwd: /^/ }, async ($: any, e: any, next: (e: any) => unknown) => {
    cwd = typeof e?.cwd === "string" && e.cwd.length > 0 ? e.cwd : await $.session.cwd();
    const fromEnv: string | undefined = await $.env.get("CLAUDE_CODE_SESSION_ID");
    clientTaskId = typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : await $.session.id();
    if (noProject[cwd] === true) return next(e);
    sessionWanted = true;
    await startSeat($, null, null);
    // The timer runs whether or not the first start landed: it retries a
    // transient failure once the backoff has passed, and cached no_project
    // makes every retry a no-op.
    if (noProject[cwd] !== true) startPoll($);
    return next(e);
  });

  on("agent.spawn", async ($: any, e: any, next: (e: any) => unknown) => {
    const result: any = await next(e);
    const agentId = result && typeof result.agentId === "string" ? result.agentId : null;
    if (agentId !== null && session !== null && !detaching) {
      const description = typeof e?.description === "string" && e.description.length > 0 ? e.description : null;
      // Enqueued now, so the child's end queues behind it; not awaited, so
      // the spawn result is never held for the writer backlog.
      startSeat($, agentId, description).catch(() => {});
    }
    return result;
  });

  on("turn.complete", { turnId: /./ }, async ($: any, e: any, next: (e: any) => unknown) => {
    const agentId = typeof e?.agentId === "string" ? e.agentId : null;
    if (agentId !== null) {
      // Not gated on the child being known yet: its start may still be in
      // the queue, and the end must take its place behind it. A loop this
      // Mod never seated (an engine fork) costs one no-op in the queue.
      await endSeat($, agentId, stateFromReason(e.reason));
    } else {
      heartbeat($, null).catch(() => {});
    }
    return next(e);
  });

  on("tool.call", { tool: /./ }, ($: any, e: any, next: (e: any) => unknown) => {
    const result = next(e);
    const agentId = typeof e?.agentId === "string" ? e.agentId : null;
    heartbeat($, agentId).catch(() => {});
    return result;
  });

  on("session.compact", { trigger: /./ }, ($: any, e: any, next: (e: any) => unknown) => {
    heartbeat($, null).catch(() => {});
    return next(e);
  });

  on("session.detach", async ($: any, e: any, next: (e: any) => unknown) => {
    // Synchronous, before any await: a spawn continuation that returns
    // after this point seats nothing. Every known child ends as part of
    // the same barrier, then the session seat itself.
    detaching = true;
    sessionWanted = false;
    // A barrier first: a child start already past the guard and awaiting
    // the CLI lands before the children are enumerated, so it is ended
    // here and not left running. Rejections (a `$` call that throws) are
    // the roster's problem, never the client's teardown: next(e) is
    // always reached.
    await enqueue(async () => undefined).catch(() => {});
    const ends = Object.keys(children).map((id) => endSeat($, id, "detached"));
    ends.push(endSeat($, null, "detached"));
    await Promise.allSettled(ends);
    return next(e);
  });
}
