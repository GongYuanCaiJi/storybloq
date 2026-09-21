# Plan: T-2 Add logging for background jobs (revision 2)

Revision 2 replaces the round-1 design after code review. Round 1's placement of the
logger construction *inside* the runner's `try` was correct about draining the queue but
wrong about scope: it put a logging concern inside the region that decides whether the job
runs. See "What changed and why" at the end.

## Goal

`JobQueue.run()` runs jobs silently and swallows failures (`catch {}`), so a job's start,
success and failure are invisible. Make all three visible in the logs.

## Rulings that bind this work

Both current, both cited by T-2:

- **r-eftp2zdb6as643np** (owner-direct, 2026-09-14, supersedes r-rvcf99q7dwhzzpav) --
  one logger, `AppLogger`; nothing else writes log lines; every line carries the request id
  of the work it belongs to; secrets redacted before the line is written.
- **r-p19bbvh0jhj8xgma** (owner-direct, 2026-09-15) -- background work logs under the
  request id of the request that enqueued it, **not** a fresh id.

Design consequences: no `console.*`, no second logger, and no queue-lifetime logger --
each job carries its own `requestId`, so the logger is built **per job** from
`job.requestId`. And because a line with no request id is not writable at all, a job whose
request id is unusable gets **no** line rather than a non-compliant one.

RULES.md adds: Node built-ins only (AppLogger is local, no new dependency), and a test
beside the module named `<Module>.test.ts`.

## The invariant this revision is built around

**Logging is additive: it never changes whether a job runs, nor how it is counted.**

That is the property round 1 broke, and it is worth naming because two different faults
attack it from opposite directions:

- an unusable request id (`AppLogger.withRequestId` throws on blank -- `AppLogger.ts:61` --
  and `enqueue` does not validate `opts.requestId`), and
- a sink that throws (the default stdout sink can, e.g. EPIPE -- `AppLogger.ts:87`).

Round 1 turned the first into "the job never ran, counted as failed, logged nothing" and
the second into "a successful job reported as failed". Both are logging faults deciding a
job's outcome. One guard placement fixes both.

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger`, `type LogLevel` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Optional constructor sink, mirroring `Router`'s existing idiom (`constructor(sink?: Sink)`
  into a private `#sink`), so a test can observe what the queue logs while production keeps
  `AppLogger`'s default.
- Add one private helper, the only place this class writes a line. **Everything that can
  throw happens inside its `try`, including the derivation of the error string** -- an error
  value is not guaranteed to be stringifiable (`String(Object.create(null))` raises "Cannot
  convert object to primitive value"), and deriving it at the call site would put that throw
  back in `run()`'s catch block, abandoning the rest of the queue. That is the same class of
  defect as round 1's, so the helper takes the raw `err` and formats it itself:

  ```ts
  #emit(job: QueuedJob, level: LogLevel, message: string, cause?: { readonly err: unknown }): void {
    try {
      const fields: Record<string, unknown> = { jobId: job.id, kind: job.kind };
      if (cause) fields.error = cause.err instanceof Error ? cause.err.message : String(cause.err);
      AppLogger.withRequestId(job.requestId, this.#sink)[level](message, fields);
    } catch {
      // A logging fault never changes a job's outcome. An unusable request id cannot
      // produce a compliant line at all (r-eftp2zdb6as643np), so the line is dropped
      // rather than written without one.
    }
  }
  ```

  The `cause` wrapper object rather than a bare `err` parameter keeps "no cause" distinct
  from "a cause that happens to be `undefined`".

- `run()` keeps **only the runner** inside the outcome-determining `try`:

  ```ts
  const job = this.#jobs.shift()!;
  this.#emit(job, "info", "job started");
  try {
    await runner(job);
    ran++;
    this.#emit(job, "info", "job succeeded");
  } catch (err) {
    failed++;
    this.#emit(job, "error", "job failed", { err });
  }
  ```

  Counters increment before the emit, so the recorded outcome is the runner's outcome and
  nothing downstream of it.
- `catch {}` becomes `catch (err)`, and `err` is handed to `#emit` unformatted so the
  `error` string (`err instanceof Error ? err.message : String(err)`) is derived under the
  guard.
- Redaction is not re-implemented: `AppLogger` already redacts message text and every string
  field at any depth, so a secret inside a thrown error's message is redacted on the way out
  (r-eftp2zdb6as643np).
- Behaviour preserved exactly, now including the blank-id case: a failing job is dropped,
  the remaining jobs still run, the return value stays `{ ran, failed }`, and a job whose
  request id is unusable still **runs** and is still counted by its own outcome -- it is
  simply not logged.

Field shape stays flat and deterministic (`jobId`, `kind`, plus `error` on failure); no
timing field, which would make the line shape nondeterministic for no scoped benefit.

**The cost of this design, stated plainly:** swallowing sink faults means a dropped line is
silent. That is the deliberate trade -- a queue drain must not abort or miscount because a
log write failed -- and it is the narrower of the two options, since the alternative lets
an EPIPE decide a job's recorded outcome. It does not weaken any ruling: nothing
non-compliant is ever written, and the only line that can go missing is one the sink itself
refused.

### 2. `src/http/handler.ts` -- deliberately unchanged

An earlier draft threaded the app's sink into the default queue. Dropped: `createApp` never
returns its queue and nothing in the repo calls `JobQueue.run()`, so that sink would be
unobservable, outside T-2's scope, and the smallest edit matching it (folding `sink` into
the existing `queue: JobQueue = new JobQueue()` initializer at `handler.ts:17`) is a TDZ
`ReferenceError`, since a default-parameter expression cannot read a later parameter -- and
that is exactly the call shape of `router.test.ts:8` (`createApp(undefined, sink)`). No
ruling requires the change: an unthreaded default queue still logs through `AppLogger`'s own
default sink, so "one logger" holds regardless.

The diff is `src/jobs/JobQueue.ts` plus its test, nothing else.

### 3. `src/jobs/JobQueue.test.ts` (per RULES.md rule 3)

Node's built-in runner, same style as `AppLogger.test.ts` (collect `LogLine`s via the
injected sink). Eight tests -- the first four from round 1, then four that pin what round 1
left uncovered:

1. **Success path** -- one job logs `job started` then `job succeeded`, both `info`, both
   under the enqueuing request id, both with `{ jobId, kind }`.
2. **Failure path** -- a throwing job logs `job started` then `job failed` at `error` with
   the message in `fields.error`; a job queued behind it still runs and logs; `run()`
   returns the whole `{ ran: 1, failed: 1 }` (asserted in full).
3. **Per-job request id** -- two jobs enqueued under different ids each log under their own,
   never a fresh one. The direct test of r-p19bbvh0jhj8xgma.
4. **Redaction on the job path** -- a job throwing an error whose message contains a
   secret-shaped token logs it `[REDACTED]`, confirming the job path inherits
   r-eftp2zdb6as643np rather than bypassing it.
5. **Unusable request id does not decide the job's fate** (new) -- a job enqueued with
   `requestId: ""` still has its runner invoked, is still counted (`ran`), writes **zero**
   log lines, and the job queued behind it still runs and logs normally. This is the
   regression test for the round-1 defect and it covers the `#emit` catch.
6. **A throwing sink does not decide the job's fate** (new) -- with a sink that throws on
   every line, a successful job is still counted as `ran` and a failing one as `failed`;
   `run()` resolves rather than rejecting. Pins the invariant from the other direction.
7. **An async rejecting runner is a counted failure** (new) -- a runner returning a rejected
   promise yields `{ ran: 0, failed: 1 }` and the `job failed` line, so the `await` in
   `run()` cannot be dropped unnoticed.
8. **An unstringifiable thrown value does not abandon the queue** (new) -- a runner throwing
   `Object.create(null)` is counted as `failed`, `run()` resolves rather than rejecting, and
   the job queued behind it still runs. Pins the derivation staying inside `#emit`'s guard.

## Verification

- `npm test` (`node --test`) -- 8 new tests plus the existing AppLogger and router tests all
  pass; `router.test.ts` passing unchanged is the check that nothing in the HTTP path moved.
- `tsc --noEmit`, reading past the pre-existing `TS2307`/`TS2580` noise recorded in ISS-002
  (no `@types/node` in this repo); no new error in the changed files.

## What changed and why (round 1 -> revision 2)

| Round 1 | Revision 2 |
|---|---|
| Logger built inside the runner's `try` | Only `runner(job)` is inside it; emits go through `#emit` |
| Blank request id: job never ran, counted `failed`, logged nothing | Blank request id: job runs, counted by its own outcome, logs nothing |
| Throwing sink could report a successful job as failed | Sink faults cannot change `{ ran, failed }` |
| Failure emit in a bespoke `#logFailure` with an inner `try` | One `#emit` guard used by all three lines |
| Defensive branch untested | Tests 5 and 6 cover it from both directions |
| Error string derived outside the guard (an unstringifiable thrown value still abandoned the queue) | Derived inside `#emit`; test 8 pins it |

## Out of scope

- Moving `AppLogger` into `packages/logging` (that is T-3).
- Job retries, timing/metrics, or changing the drop-on-failure semantics.
- Validating `requestId` at `enqueue` time. The review named it as an alternative fix and it
  is a reasonable one, but it changes `enqueue`'s public contract (a new throw) for a fault
  no current caller can reach, and the queue would still need the `#emit` guard for sink
  faults. Left as a separate decision.
- Draining the queue in production: nothing calls `JobQueue.run()` today, so these lines are
  reachable only from tests. Filed as an issue during review, not fixed here.
- The pre-existing blank-request-id hole at `handler.ts:31` (`?? randomUUID()` does not catch
  an empty or whitespace header), filed as an issue.
