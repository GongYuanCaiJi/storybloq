# Plan: T-2 Add logging for background jobs

## Goal

`JobQueue.run()` logs nothing today (`src/jobs/JobQueue.ts:32`). Make each job's
start, success and failure visible in the logs, without breaking either logging
guarantee this project already holds.

## Rulings this ticket cites

Both are current; neither has a successor. They were not on the ticket when this
session picked it up (`citedRulings: []`) and were added to T-2 during PLAN, so the
review stages receive them.

- **r-eftp2zdb6as643np** (2026-09-14, current; supersedes the shorter 09-10 wording
  r-rvcf99q7dwhzzpav) -- "Logging keeps redaction and request ids on every path. One
  logger, AppLogger; nothing else writes log lines. Every line carries the request id
  of the work it belongs to, and secrets are redacted before the line is written."
- **r-p19bbvh0jhj8xgma** (2026-09-15, current) -- "Background work carries the request
  id of the job that enqueued it. When a job runs, anything it logs is under the
  request id of the request that put it on the queue, not a fresh id."

What they force on this design:

1. No `console.*`, no second logger, no bespoke line format in `src/jobs/`. Every
   line goes through `AppLogger`.
2. The logger for a running job is bound to `job.requestId` -- the id `enqueue()`
   already records (`JobQueue.ts:24`). A fresh `randomUUID()` per job run is exactly
   what r-p19bbvh0jhj8xgma forbids.
3. Anything derived from job data (notably a thrown error's message) reaches the sink
   through `AppLogger`'s redaction, which already covers message text and string
   fields at any depth (`AppLogger.ts:39-45`).

RULES.md adds: Node built-ins only (satisfied -- `AppLogger` is local, no new
imports), and a test beside the change named `<Module>.test.ts`.

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add an optional sink to the class, mirroring `Router`'s existing shape
  (`router.ts:24-29`) so a test can observe what jobs log and production keeps
  `AppLogger`'s default stdout sink:
  ```ts
  readonly #sink: Sink | undefined;
  constructor(sink?: Sink) { this.#sink = sink; }
  ```
  `new JobQueue()` keeps working, so `handler.ts` and any existing caller are
  source-compatible.
- **Guard the request id at `enqueue()`, not at `run()`** (plan review round 1, major).
  `AppLogger.withRequestId` throws on a blank id (`AppLogger.ts:61`) and `enqueue()`
  validates nothing today (`JobQueue.ts:22-26`), so a job enqueued with
  `requestId: ""` is representable. If `run()` built its logger for such a job, the
  throw would escape `run()` after the job was already `shift()`ed off: the job is
  lost, the remaining jobs never run, and `{ ran, failed }` never returns --
  breaking `run()`'s own contract at `JobQueue.ts:32`. Adding logging must not let a
  bad request id abort the batch.

  The root-cause fix is at the boundary, because a job with no request id can never
  satisfy r-p19bbvh0jhj8xgma anyway -- there is no id to log it under:
  ```ts
  enqueue(job: Job, opts: { requestId: string }): string {
    if (opts.requestId.trim() === "") throw new Error("JobQueue requires a non-empty request id");
    ...
  }
  ```
  This mirrors `AppLogger`'s own guard and its wording. It throws synchronously in the
  caller's own frame, where nothing has been queued and nothing can be lost -- the
  opposite of throwing mid-drain.
- In `run()`, per job, before the `try`:
  ```ts
  const log = AppLogger.withRequestId(job.requestId, this.#sink);
  log.info("job started", { jobId: job.id, kind: job.kind });
  ```
  on success: `log.info("job succeeded", { jobId: job.id, kind: job.kind })`
  on failure, inside the existing `catch (err)`:
  `log.error("job failed", { jobId: job.id, kind: job.kind, error: errorMessage(err) })`

  Constructing the logger outside the `try` is safe *given the guard above*, and the
  reason is worth stating because it is the whole argument: `#jobs` is private and
  `enqueue()` is the only thing that pushes to it, so every job in the queue has a
  non-empty `requestId` and `withRequestId` cannot throw on it. The invariant is
  established where it can be established cheaply and asserted by a test, rather than
  re-checked on every drain.
- Add a module-local `errorMessage(err: unknown): string` (plan review round 1, minor).
  `String(err)` is not total: it throws for a null-prototype object or an object with
  a throwing `toString`, and it would run *inside* the `catch`, so that secondary
  throw would escape `run()` and abort the rest of the batch exactly as above. Make
  the conversion total:
  ```ts
  function errorMessage(err: unknown): string {
    try {
      return err instanceof Error ? String(err.message) : String(err);
    } catch {
      return "unknown error";
    }
  }
  ```
  (`err.message` is itself `String()`-ed because an `Error` subclass may carry a
  non-string `message`, and the field is typed as one.) The result is a plain string
  field, so `redact()` runs `redactMessage` over it and a secret inside an upstream
  error message is redacted before the line is written.
- Do **not** log `job.payload`. It is arbitrary request body; redaction is a
  backstop, not a licence to write whole payloads to the log. `kind` and `jobId`
  are what makes a job identifiable.
- The existing control flow is unchanged: a failing job is still swallowed, the
  remaining jobs still run, and `{ ran, failed }` still means what it meant.
- Update the file's header comment -- it currently states "Running a job does not
  log anything yet", which this change makes false.

### 2. `src/http/handler.ts` -- no change (dropped, plan review round 1)

The first draft rewired `createApp` so its default queue could receive the sink.
Dropped for two reasons the review made concrete: it has no observable effect today
(`createApp` never exposes the queue it constructs, so nothing outside can call
`run()` on it), and it therefore cannot be tested without widening the public API,
which RULES.md rule 3 would require of a behaviour change. Shipping an untested
signature change to buy nothing is the wrong trade for this ticket.

Filed instead as **ISS-001**, with the fix written out (resolve the queue in the
body, repoint the route closure at `handler.ts:24`, add `handler.test.ts`) for
whenever something actually needs the app's own queue to run jobs.

`handler.ts` is therefore untouched: `createApp` keeps its current signature, and a
caller that wants job logs on its own sink passes `new JobQueue(sink)` in.

### 3. `src/jobs/JobQueue.test.ts` (new)

Node's built-in runner, same style as the two existing test files.

1. **Success path, enqueuing request id.** Enqueue one job with
   `{ requestId: "req-enqueued-1" }`, run a runner that resolves. Assert two lines,
   `"job started"` then `"job succeeded"`, both with `requestId === "req-enqueued-1"`,
   and `jobId`/`kind` on the fields. This is the r-p19bbvh0jhj8xgma assertion: the id
   is the enqueuing request's, not a new one.
2. **Failure path, and the batch survives it.** Three jobs where the middle runner
   throws. Assert a `"job started"` then an `error`-level `"job failed"` line
   carrying the error text, that the id is still the enqueuing one, that the third
   job still ran, and that `run()` returns `{ ran: 2, failed: 1 }`. Note what this
   does and does not cover: it pins that adding logging did not perturb the existing
   batch-survival contract, but the throw comes from the *runner*, which the existing
   `catch` (`JobQueue.ts:41`) already handled. Test 5 is what pins the round-1 major
   finding itself.
3. **Two jobs from two different requests.** Each pair of lines carries its own
   request id -- one job's lines never inherit the other's.
4. **Redaction on the failure path.** A runner throwing
   `new Error("upstream refused Bearer abc")` produces a line whose `error` field
   reads `upstream refused [REDACTED]`. This is the r-eftp2zdb6as643np assertion at
   the job boundary.
5. **`enqueue` rejects a blank request id.** `assert.throws(() => queue.enqueue(job,
   { requestId: "  " }), /non-empty request id/)`, and the queue stays empty
   (`size === 0`). **This is the round-1 major finding's regression test**: it pins
   the invariant that lets `run()` build its logger without a per-job guard, at the
   only place a job can enter the queue.
6. **A non-`Error` throw is logged, not propagated.** A runner that does
   `throw Object.create(null)` still produces a `"job failed"` line (`error` reads
   `unknown error`) and still lets the rest of the batch run -- the round-1 minor
   finding's regression test.
7. **An `Error` carrying a non-string `message`.** The `String(err.message)` branch
   exists for this and test 6 does not reach it (a null-prototype throw takes the
   `String(err)` path). Throw an `Error` subclass whose `message` is not a string and
   assert the `error` field is still a string on the line.

## Verification

- `npm test` (Node's runner, discovers every `*.test.ts`) -- new JobQueue tests pass
  and the existing router and AppLogger tests are untouched and still green.
- `src/http/router.test.ts` asserts exactly one line for a `POST /reports`; jobs log
  only inside `run()`, which that test never calls, so the count stays 1. `handler.ts`
  is untouched, so that test's `createApp(undefined, sink)` call is unaffected.
- Grep `src/jobs/` for `console.` to confirm nothing writes a log line outside
  `AppLogger`.

## Out of scope

- T-3 (move `AppLogger` to `packages/logging`) -- imports here stay pointing at
  `src/platform/logging/`.
- ISS-001, the `createApp` default-queue sink gap dropped from this plan above.
- Job durations/timing fields, a retry policy, and any change to how failures are
  swallowed. The ticket asks for visibility, not new queue behaviour.
- A sink that itself throws. `AppLogger` calls the sink directly (`AppLogger.ts:82`),
  so a throwing sink already escapes `Router.dispatch` today. `run()`'s exposure is
  worse, not equal, and the plan should not claim otherwise: a throwing sink there
  loses the already-`shift()`ed job and aborts the rest of the drain, where in
  `Router` it fails one `dispatch`. Moving the log calls inside the `try` would not
  fix it -- the `"job failed"` line throws from the same sink. Containing it belongs
  in `AppLogger`, for every caller at once, rather than in one queue.
