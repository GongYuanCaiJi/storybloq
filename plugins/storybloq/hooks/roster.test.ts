/**
 * T-507: the seat roster Mod, under `claude plugin test`.
 *
 * Driven through `registerRoster` directly for the reason sidebar.test.ts
 * gives: the Mod is off by default and the kit cannot set a plugin's
 * options, so the harness below stands in for the engine with a recording
 * `on`, a `$` whose `process.run` answers as the storybloq CLI would, an
 * `agent.list` the test fills, and a clock the test turns by hand. The
 * source scan itself is what test/plugin/roster-validate.test.ts checks
 * with the client.
 *
 * Two mutants this file is built around: M-NO-FINISH (drop the
 * `turn.complete` handler and a finished child's seat is never ended) and
 * M-NO-POLL (drop the `$.clock.every` poll and a killed child's seat is
 * never ended), plus M-NO-RETRY (the timer never retries a failed session
 * start), M-DETACH-RACE (a spawn answered after the detach seats a child
 * nothing will end), M-NO-DETACH-BARRIER (a child start in flight at the
 * detach is never ended) and M-ALL-NOT-SETTLED (an end that rejects keeps
 * the detach from reaching the client's next()).
 */

import { test, expect } from "claude-code/testing";
import { registerRoster, HEARTBEAT_MS, POLL_MS, BACKOFF_MS } from "./roster.js";

interface Run {
  readonly argv: readonly string[];
  readonly init: { cwd?: string; stdin?: string; timeoutMs?: number };
  readonly body: Record<string, unknown>;
}

type Answer = { exitCode: number; stdout: string; stderr: string };

interface Harness {
  readonly runs: Run[];
  readonly logged: string[];
  readonly timers: { ms: number; fn: () => void }[];
  agents: { id: string; status: string }[];
  now: number;
  /** When true, `$.clock.every` refuses the registration by throwing. */
  refuseTimers: boolean;
  /** When set, `$.clock.now` answers with this promise instead: a `$` call held or failing under a queued write. */
  clockAnswer: Promise<number> | null;
  /** Every event whose hook called next(), in order. */
  readonly nextCalls: string[];
  /** Answers the next CLI calls; the default is a success envelope. */
  answer: (run: Run) => Promise<Answer>;
  fire(event: string, e: unknown, nextResult?: unknown): Promise<unknown>;
  tick(): Promise<void>;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ok(data: Record<string, unknown>): Answer {
  return { exitCode: 0, stdout: JSON.stringify({ version: 1, data }), stderr: "" };
}

function refused(code: string, message = code): Answer {
  return { exitCode: 2, stdout: JSON.stringify({ version: 1, error: { code, message } }), stderr: "" };
}

function verb(run: Run): string {
  return run.argv[2]!;
}

function harness(env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: "sess-1" }): Harness {
  const hooks: Record<string, (...args: any[]) => any> = {};
  const runs: Run[] = [];
  const logged: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const nextCalls: string[] = [];
  const state = {
    now: 1_000_000,
    refuseTimers: false,
    clockAnswer: null as Promise<number> | null,
    agents: [] as { id: string; status: string }[],
    answer: async (run: Run): Promise<Answer> => {
      if (verb(run) === "start") return ok({ ok: true, generation: 1, state: "running" });
      return ok({ ok: true, generation: run.body["generation"], state: verb(run) === "end" ? run.body["state"] : "running" });
    },
  };

  const $ = {
    process: {
      run: async (argv: readonly string[], init: Run["init"]): Promise<Answer> => {
        const run: Run = { argv, init, body: JSON.parse(init.stdin ?? "{}") };
        runs.push(run);
        return state.answer(run);
      },
    },
    agent: { list: async () => state.agents.map((a) => ({ ...a, description: "", type: "general-purpose" })) },
    clock: {
      now: async () => {
        if (state.clockAnswer !== null) return state.clockAnswer;
        return state.now;
      },
      every: (ms: number, fn: () => void) => {
        if (state.refuseTimers) throw new Error("every: refused by a hook beneath");
        timers.push({ ms, fn });
        return { cancel: () => {} };
      },
    },
    env: { get: async (name: string) => env[name] },
    session: { id: async () => "from-session-id", cwd: async () => "/from-session-cwd" },
    ui: { log: (message: string) => { logged.push(message); } },
  };

  const on = (event: string, a: unknown, b?: unknown) => {
    hooks[event] = (typeof a === "function" ? a : b) as (...args: any[]) => any;
    return { catch: () => undefined };
  };
  registerRoster(on as any, {});

  return {
    runs,
    logged,
    timers,
    get agents() { return state.agents; },
    set agents(value) { state.agents = value; },
    get now() { return state.now; },
    set now(value) { state.now = value; },
    get answer() { return state.answer; },
    set answer(value) { state.answer = value; },
    get refuseTimers() { return state.refuseTimers; },
    set refuseTimers(value) { state.refuseTimers = value; },
    get clockAnswer() { return state.clockAnswer; },
    set clockAnswer(value) { state.clockAnswer = value; },
    nextCalls,
    async fire(event, e, nextResult) {
      const hook = hooks[event];
      if (!hook) throw new Error(`no hook registered for ${event}`);
      const result = await hook($, e, (passed: unknown) => {
        nextCalls.push(event);
        return nextResult === undefined ? passed : nextResult;
      });
      await flush();
      await flush();
      return result;
    },
    async tick() {
      for (const timer of [...timers]) timer.fn();
      await flush();
      await flush();
    },
  };
}

const START = { cwd: "/repo", surface: "terminal", isInteractive: true };

async function seated(h: Harness): Promise<void> {
  await h.fire("session.start", START);
}

test("session.start seats the session through the CLI, identity from the client's session id variable, and arms one poll", async () => {
  const h = harness();
  await seated(h);
  expect(h.runs).toHaveLength(1);
  const run = h.runs[0]!;
  expect(run.argv).toEqual(["storybloq", "roster", "start", "--stdin", "--format", "json"]);
  expect(run.init.cwd).toBe("/repo");
  expect(run.init.timeoutMs).toBe(5000);
  expect(run.body).toEqual({ clientTaskId: "sess-1", sessionId: "sess-1", description: null });
  expect(h.timers).toHaveLength(1);
  expect(h.timers[0]!.ms).toBe(POLL_MS);
});

test("a refused $.clock.every leaves session.start whole, and the next session.start registers the poll", async () => {
  const h = harness();
  h.refuseTimers = true;
  await seated(h);
  expect(h.runs).toHaveLength(1);
  expect(h.timers).toHaveLength(0);
  h.refuseTimers = false;
  await h.fire("session.start", START);
  expect(h.timers).toHaveLength(1);
  expect(h.runs).toHaveLength(1); // the seat it already holds is not started twice
});

test("without the variable the identity is $.session.id(), and without e.cwd the cwd is $.session.cwd()", async () => {
  const h = harness({});
  await h.fire("session.start", { surface: null, isInteractive: false });
  expect(h.runs[0]!.body["clientTaskId"]).toBe("from-session-id");
  expect(h.runs[0]!.init.cwd).toBe("/from-session-cwd");
});

test("an empty e.cwd also falls through to $.session.cwd() (the matcher admits the empty string)", async () => {
  const h = harness();
  expect("".match(/^/)).not.toBeNull();
  await h.fire("session.start", { cwd: "", surface: "terminal", isInteractive: true });
  expect(h.runs).toHaveLength(1);
  expect(h.runs[0]!.init.cwd).toBe("/from-session-cwd");
});

test("no_project is cached for the cwd: nothing further is run there and nothing is logged", async () => {
  const h = harness();
  h.answer = async () => refused("no_project", "No .story/ project found");
  await seated(h);
  expect(h.runs).toHaveLength(1);
  await h.fire("tool.call", { tool: "Read" });
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  await h.fire("session.detach", { reason: "detached" });
  await h.fire("session.start", START);
  expect(h.runs).toHaveLength(1);
  expect(h.logged).toEqual([]);
  expect(h.timers).toHaveLength(0);
  // Per cwd: another directory is asked, and /repo stays suppressed.
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] ?? 1 });
  await h.fire("session.start", { ...START, cwd: "/other" });
  expect(h.runs).toHaveLength(2);
  expect(h.runs[1]!.init.cwd).toBe("/other");
  await h.fire("session.start", START);
  expect(h.runs).toHaveLength(2);
});

test("a spawned child is seated after next() names it, and its own turn.complete ends it completed (M-NO-FINISH)", async () => {
  const h = harness();
  await seated(h);
  const result = await h.fire("agent.spawn", { description: "greps the tree" }, { model: "m", agentId: "ag-1" });
  expect(result).toEqual({ model: "m", agentId: "ag-1" });
  expect(h.runs).toHaveLength(2);
  expect(verb(h.runs[1]!)).toBe("start");
  expect(h.runs[1]!.body).toEqual({ clientTaskId: "sess-1", sessionId: "sess-1", description: "greps the tree", agentId: "ag-1" });
  await h.fire("turn.complete", { agentId: "ag-1", reason: "answer", turnId: "t1" });
  expect(h.runs).toHaveLength(3);
  expect(verb(h.runs[2]!)).toBe("end");
  expect(h.runs[2]!.body).toEqual({ clientTaskId: "sess-1", generation: 1, state: "completed", agentId: "ag-1" });
  // Ended once: a second turn.complete for the same child writes nothing.
  await h.fire("turn.complete", { agentId: "ag-1", reason: "answer", turnId: "t2" });
  expect(h.runs).toHaveLength(3);
});

test("a child's end state follows the turn's reason: error and refusal are failed, aborted is killed", async () => {
  const h = harness();
  await seated(h);
  for (const [id, reason, state] of [["a", "error", "failed"], ["b", "refusal", "failed"], ["c", "aborted", "killed"]] as const) {
    await h.fire("agent.spawn", { description: id }, { model: "m", agentId: id });
    await h.fire("turn.complete", { agentId: id, reason, turnId: id });
    const end = h.runs[h.runs.length - 1]!;
    expect(verb(end)).toBe("end");
    expect(end.body["state"]).toBe(state);
  }
});

test("a spawn next() denied seats nothing", async () => {
  const h = harness();
  await seated(h);
  await h.fire("agent.spawn", { description: "x" }, { deny: "no" });
  expect(h.runs).toHaveLength(1);
});

test("agent.spawn hands the result back while the child's start is still in flight", async () => {
  const h = harness();
  await seated(h);
  let release: (() => void) | null = null;
  h.answer = () => new Promise((resolve) => { release = () => resolve(ok({ ok: true, generation: 1 })); });
  const result = await h.fire("agent.spawn", { description: "slow" }, { model: "m", agentId: "ag-1" });
  expect(result).toEqual({ model: "m", agentId: "ag-1" });
  expect(h.runs).toHaveLength(2); // started, not landed
  release!();
  await flush();
  await flush();
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] });
  await h.fire("turn.complete", { agentId: "ag-1", reason: "answer", turnId: "t" });
  expect(h.runs.map(verb)).toEqual(["start", "start", "end"]);
});

test("two beats asked for in the same tick fold into one write", async () => {
  const h = harness();
  await seated(h);
  h.now += HEARTBEAT_MS;
  const first = h.fire("tool.call", { tool: "Read" });
  const second = h.fire("tool.call", { tool: "Grep" });
  await Promise.all([first, second]);
  expect(h.runs.map(verb)).toEqual(["start", "heartbeat"]);
});

test("the poll ends a child the client lists as killed, failed or completed, and leaves running or absent children alone (M-NO-POLL)", async () => {
  const h = harness();
  await seated(h);
  for (const id of ["run", "gone", "dead", "done", "fail"]) {
    await h.fire("agent.spawn", { description: id }, { model: "m", agentId: id });
  }
  expect(h.runs).toHaveLength(6);
  h.agents = [
    { id: "run", status: "running" },
    { id: "dead", status: "killed" },
    { id: "done", status: "completed" },
    { id: "fail", status: "failed" },
  ];
  await h.tick();
  const ends = h.runs.slice(6).map((r) => [r.body["agentId"], r.body["state"]]);
  expect(ends).toEqual([["dead", "killed"], ["done", "completed"], ["fail", "failed"]]);
  // The next period finds nothing new to end.
  await h.tick();
  expect(h.runs).toHaveLength(9);
});

test("tool.call returns next's answer before any write and heartbeats at most once per five minutes per seat", async () => {
  const h = harness();
  await seated(h);
  let release: (() => void) | null = null;
  h.answer = (run) => new Promise((resolve) => { release = () => resolve(ok({ ok: true, generation: run.body["generation"] })); });
  const result = await h.fire("tool.call", { tool: "Read" }, "tool-answer");
  expect(result).toBe("tool-answer");
  expect(h.runs).toHaveLength(1); // the seat was started under the floor: no beat yet
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read" }, "tool-answer");
  expect(h.runs).toHaveLength(2);
  expect(verb(h.runs[1]!)).toBe("heartbeat");
  expect(h.runs[1]!.body).toEqual({ clientTaskId: "sess-1", generation: 1 });
  // A second call while that beat is in flight coalesces.
  await h.fire("tool.call", { tool: "Grep" }, "tool-answer");
  expect(h.runs).toHaveLength(2);
  release!();
  await flush();
  await flush();
  // Within the floor after it landed: still nothing.
  await h.fire("tool.call", { tool: "Grep" }, "tool-answer");
  expect(h.runs).toHaveLength(2);
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Grep", agentId: "nobody" }, "tool-answer");
  expect(h.runs).toHaveLength(2); // an unknown loop has no seat to beat
  await h.fire("tool.call", { tool: "Grep" }, "tool-answer");
  expect(h.runs).toHaveLength(3);
});

test("a child's tool.call beats the child's seat, and session.compact beats the session's", async () => {
  const h = harness();
  await seated(h);
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read", agentId: "ag-1" });
  await h.fire("session.compact", { trigger: "auto", messages: [] });
  const beats = h.runs.slice(2).map((r) => [verb(r), r.body["agentId"] ?? null]);
  expect(beats).toEqual([["heartbeat", "ag-1"], ["heartbeat", null]]);
});

test("a failing CLI is logged once and backed off for a minute; the timer retries the session's start after the backoff (M-NO-RETRY)", async () => {
  const h = harness();
  h.answer = async () => { throw new Error("spawn ENOENT storybloq"); };
  await seated(h);
  expect(h.runs).toHaveLength(1);
  expect(h.logged).toHaveLength(1);
  expect(h.logged[0]).toContain("ENOENT");
  expect(h.timers).toHaveLength(1); // armed even though the start failed
  // Within the backoff: no seat, so a spawned child is not seated and the timer writes nothing.
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "early" });
  await h.tick();
  expect(h.runs).toHaveLength(1);
  h.now += BACKOFF_MS;
  await h.tick();
  expect(h.runs).toHaveLength(2);
  expect(verb(h.runs[1]!)).toBe("start");
  expect(h.logged).toHaveLength(1);
  // A write_failed envelope is the same class of failure.
  h.answer = async () => refused("write_failed", "EACCES");
  h.now += BACKOFF_MS;
  await h.tick();
  expect(h.runs).toHaveLength(3);
  h.now += 1;
  await h.tick();
  expect(h.runs).toHaveLength(3);
  // Once the CLI answers, the session is seated and children seat again.
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] ?? 2 });
  h.now += BACKOFF_MS;
  await h.tick();
  expect(h.runs.map(verb)).toEqual(["start", "start", "start", "start"]);
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "late" });
  expect(h.runs[4]!.body["agentId"]).toBe("late");
  // Seated: the timer does not start it again.
  await h.tick();
  expect(h.runs).toHaveLength(5);
});

test("session.detach ends every child and then the session seat, detached, with their generations", async () => {
  const h = harness();
  h.answer = async (run) => (verb(run) === "start" ? ok({ ok: true, generation: run.body["agentId"] ? 2 : 4 }) : ok({ ok: true }));
  await seated(h);
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  await h.fire("session.detach", { reason: "detached", surface: "terminal", clientId: "c" });
  expect(h.runs.map(verb)).toEqual(["start", "start", "end", "end"]);
  expect(h.runs[2]!.body).toEqual({ clientTaskId: "sess-1", generation: 2, state: "detached", agentId: "ag-1" });
  expect(h.runs[3]!.body).toEqual({ clientTaskId: "sess-1", generation: 4, state: "detached" });
  // Detached is terminal: no later beat, and no child is seated after it.
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read" });
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-2" });
  expect(h.runs).toHaveLength(4);
});

test("a spawn whose next() returns after session.detach began seats nothing, even when the detach's own end was skipped by a backoff (M-DETACH-RACE)", async () => {
  const h = harness();
  await seated(h);
  // The CLI goes down: a beat fails and the backoff begins, so the detach
  // below cannot write the session's end and the seat is not marked ended.
  h.answer = async () => { throw new Error("spawn ENOENT storybloq"); };
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read" });
  expect(h.runs.map(verb)).toEqual(["start", "heartbeat"]);
  let releaseSpawn: (() => void) | null = null;
  const spawn = h.fire("agent.spawn", { description: "x" }, new Promise<unknown>((resolve) => {
    releaseSpawn = () => resolve({ model: "m", agentId: "ag-late" });
  }));
  await flush();
  await h.fire("session.detach", { reason: "detached", surface: "terminal", clientId: "c" });
  // The CLI is back and the backoff has passed when the spawn finally answers.
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] ?? 1 });
  h.now += BACKOFF_MS;
  releaseSpawn!();
  await spawn;
  await flush();
  expect(h.runs.map(verb)).toEqual(["start", "heartbeat"]);
});

test("a child whose start is in flight when session.detach arrives is ended by the detach, not left running (M-NO-DETACH-BARRIER)", async () => {
  const h = harness();
  await seated(h);
  let releaseStart: (() => void) | null = null;
  h.answer = (run) => {
    if (verb(run) === "start") return new Promise((resolve) => { releaseStart = () => resolve(ok({ ok: true, generation: 3 })); });
    return Promise.resolve(ok({ ok: true }));
  };
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  expect(h.runs.map(verb)).toEqual(["start", "start"]); // the child's start is awaiting the CLI
  const detach = h.fire("session.detach", { reason: "detached", surface: "terminal", clientId: "c" });
  await flush();
  releaseStart!();
  await detach;
  expect(h.runs.map(verb)).toEqual(["start", "start", "end", "end"]);
  expect(h.runs[2]!.body).toEqual({ clientTaskId: "sess-1", generation: 3, state: "detached", agentId: "ag-1" });
  expect(h.runs[3]!.body["agentId"]).toBeUndefined();
});

test("an end that rejects under session.detach still lets the detach reach next() (M-ALL-NOT-SETTLED)", async () => {
  const h = harness();
  await seated(h);
  // A failed beat puts a backoff in force, so every later write consults the clock.
  h.answer = async () => { throw new Error("spawn ENOENT storybloq"); };
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read" });
  // The end's clock read is held, then refused: the detach must wait for it
  // to settle before reaching next(), and must reach next() all the same.
  let refuse: ((err: Error) => void) | null = null;
  h.clockAnswer = new Promise<number>((_resolve, reject) => { refuse = reject; });
  h.clockAnswer.catch(() => {});
  const detach = h.fire("session.detach", { reason: "detached", surface: "terminal", clientId: "c" }, "detach-answer").then(
    (answer) => answer,
    () => "rejected",
  );
  await flush();
  await flush();
  expect(h.nextCalls).not.toContain("session.detach"); // still waiting on the end
  refuse!(new Error("clock: refused"));
  expect(await detach).toBe("detach-answer");
  expect(h.nextCalls).toContain("session.detach");
});

test("the writer is serialized: a child's end waits for its slow start and carries the generation that start answered", async () => {
  const h = harness();
  await seated(h);
  let releaseStart: (() => void) | null = null;
  h.answer = (run) => {
    if (verb(run) === "start") return new Promise((resolve) => { releaseStart = () => resolve(ok({ ok: true, generation: 7 })); });
    return Promise.resolve(ok({ ok: true }));
  };
  const spawn = h.fire("agent.spawn", { description: "slow" }, { model: "m", agentId: "ag-s" });
  await flush();
  const finish = h.fire("turn.complete", { agentId: "ag-s", reason: "answer", turnId: "t" });
  await flush();
  expect(h.runs.map(verb)).toEqual(["start", "start"]);
  releaseStart!();
  await spawn;
  await finish;
  expect(h.runs.map(verb)).toEqual(["start", "start", "end"]);
  expect(h.runs[2]!.body).toEqual({ clientTaskId: "sess-1", generation: 7, state: "completed", agentId: "ag-s" });
});

test("a refused end (the ledger already moved the seat on) is treated as ended, without a log or a backoff", async () => {
  const h = harness();
  await seated(h);
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  h.answer = async () => refused("refused_transition", "generation 1 is not the seat's");
  await h.fire("turn.complete", { agentId: "ag-1", reason: "answer", turnId: "t" });
  expect(h.runs).toHaveLength(3);
  expect(h.logged).toEqual([]);
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] });
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read", agentId: "ag-1" });
  expect(h.runs).toHaveLength(3);
  await h.fire("tool.call", { tool: "Read" });
  expect(h.runs).toHaveLength(4); // the session seat is untouched by the child's refusal
});

test("invalid_input is not backed off either: the next eligible write runs at once, and nothing is logged", async () => {
  const h = harness();
  await seated(h);
  h.answer = async () => refused("invalid_input", "description too long");
  await h.fire("agent.spawn", { description: "x" }, { model: "m", agentId: "ag-1" });
  expect(h.runs).toHaveLength(2);
  expect(h.logged).toEqual([]);
  h.answer = async (run) => ok({ ok: true, generation: run.body["generation"] ?? 1 });
  h.now += HEARTBEAT_MS;
  await h.fire("tool.call", { tool: "Read" });
  expect(h.runs.map(verb)).toEqual(["start", "start", "heartbeat"]);
});
