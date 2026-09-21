# Plan: T-2 Add logging for background jobs

## Ticket

T-2 (task, phase p1, risk low): Background jobs run without any log output today. Add logging for
background jobs in `src/jobs/` so that a job's start, success and failure are visible in the logs.

## Rulings that bind this work

T-2 records no `citesRulings` today, so the plan-pin gate demands nothing. Two CURRENT rulings
nevertheless govern every line this ticket adds, and step 0 cites them on the ticket so the review
stages and any later agent are shown them rather than told there is nothing:

- **r-eftp2zdb6as643np** (2026-09-14, current; supersedes r-rvcf99q7dwhzzpav): "Logging keeps
  redaction and request ids on every path. One logger, AppLogger; nothing else writes log lines.
  Every line carries the request id of the work it belongs to, and secrets are redacted before the
  line is written."
- **r-p19bbvh0jhj8xgma** (2026-09-15, current): "Background work carries the request id of the job
  that enqueued it. When a job runs, anything it logs is under the request id of the request that
  put it on the queue, not a fresh id."

r-rvcf99q7dwhzzpav is superseded and is NOT cited. r-fxdxynjdpcxprdhn (billing/integer cents) does
not touch this path.

Consequences, stated as constraints on the code below:

1. `JobQueue` must not write log lines itself (no `console`, no `process.stdout`). It goes through
   `AppLogger`.
2. Each job's lines are emitted by an `AppLogger` bound to **that job's own `requestId`** —
   `QueuedJob.requestId`, recorded at enqueue time. Never `randomUUID()`, never a queue-level or
   per-`run()` id, and never one job's id reused for the next.
3. Redaction is already enforced inside `AppLogger#emit` for both the message and the fields, so
   error text and any field go through it rather than around it.

Also binding: RULES.md #2 (Node built-ins only — no dependency is added) and #3 (a behaviour change
ships with `<Module>.test.ts` in the same directory — `src/jobs/JobQueue.test.ts`).

## Current state

- `src/jobs/JobQueue.ts` — `enqueue()` stamps `id`, `requestId`, `enqueuedAt`; `run(runner)` drains
  the queue in order, counts `ran`/`failed`, and swallows the failure with a bare `catch {}`. Nothing
  logs. No test file exists for this module.
- `src/platform/logging/AppLogger.ts` — `AppLogger.withRequestId(requestId, sink?)`; `info`/`warn`/
  `error`; throws on a blank request id; redacts message and fields.
- `src/http/router.ts` — the pattern to copy: takes an optional `Sink` in its constructor, holds it
  in a private field, and builds a per-request logger in `dispatch`.
- `src/http/handler.ts` — `createApp(queue = new JobQueue(), sink?)`; the default queue is built
  before `sink` is in play, so today a caller-supplied sink cannot reach the queue.

## Changes

### 0. Cite the rulings on T-2 (ledger, no code)

`storybloq_ticket_update` with `citesRuling: ["r-eftp2zdb6as643np", "r-p19bbvh0jhj8xgma"]` — the two
current ids above. This is what delivers them into the plan-review and code-review packets.

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add an optional sink constructor, mirroring `Router`: `constructor(sink?: Sink)` storing
  `readonly #sink: Sink | undefined`. Default construction (`new JobQueue()`) keeps AppLogger's
  default stdout sink, so production behaviour needs no wiring.
- `enqueue()`: reject a blank request id up front —
  `if (opts.requestId.trim() === "") throw new Error("JobQueue requires a non-empty request id")`.
  Rationale: `AppLogger.withRequestId` throws on a blank id, so a job enqueued without one could not
  be logged under its own id at `run()` time; the two ways out of that would be inventing a fresh id
  (which r-p19bbvh0jhj8xgma forbids) or dropping the lines (which r-eftp2zdb6as643np forbids).
  Failing at enqueue keeps the unloggable job out of the queue, and fails at the call site that
  actually knows the request, instead of mid-drain.
- `run(runner)`: inside the loop, after shifting the job, build one logger per job —
  `const log = AppLogger.withRequestId(job.requestId, this.#sink)` — and emit:
  - before `await runner(job)`: `log.info("job started", { jobId: job.id, kind: job.kind })`
  - after it resolves: `log.info("job succeeded", { jobId: job.id, kind: job.kind })`
  - in the catch: `log.error("job failed", { jobId: job.id, kind: job.kind, error: <text> })`
    where `<text>` is `err instanceof Error ? err.message : String(err)`. Change the bare
    `catch {}` to `catch (err)`. The message text is passed as a FIELD rather than interpolated into
    the log message, but either route is redacted; the field keeps the message stable for grepping.
  - `job.payload` is deliberately not logged: it is caller-controlled `unknown`, and start/success/
    failure visibility is what the ticket asks for.
- The `{ ran, failed }` contract, the drain order, and "a failing job is dropped; the rest still run"
  are unchanged — the `catch` still swallows after logging.
- Update the file's header comment, which currently states "Running a job does not log anything yet."

### 2. `src/http/handler.ts`

Change the default-queue construction so an injected sink reaches the queue:
`export function createApp(queue?: JobQueue, sink?: Sink)` with `const jobs = queue ?? new JobQueue(sink)`.
Without this, a test that passes a sink and lets the queue default would see route lines but no job
lines. An explicitly passed queue is left exactly as given (its own sink wins), which is what a
caller constructing one means.

### 3. `src/jobs/JobQueue.test.ts` (new)

Node's built-in runner, `import test from "node:test"` / `assert from "node:assert/strict"`, matching
the existing two test files.

1. **start and success are logged under the enqueuing request id** — enqueue one job with
   `requestId: "req-job-1"`, `run()` a resolving runner, assert two lines, both
   `requestId === "req-job-1"`, messages `"job started"` then `"job succeeded"`, and `fields`
   carrying `jobId`/`kind`. Asserts the ruling directly.
2. **a failing job logs a failure and the rest still run** — two jobs with DIFFERENT request ids,
   the first runner throwing; assert `{ ran: 1, failed: 1 }`, that the failure line is `level:
   "error"` with message `"job failed"` and `fields.error` carrying the thrown message, and that each
   job's lines carry its OWN request id. The differing ids are the point: a queue-level logger would
   pass test 1 and fail here.
3. **secrets in a job failure are redacted** — a runner throwing an error whose message contains
   `Bearer abc` / an `sk-...` token; assert the emitted `fields.error` reads `[REDACTED]` in place of
   the token. Guards the redaction half of r-eftp2zdb6as643np on the new path.
4. **a job cannot be enqueued without a request id** — `assert.throws(() => queue.enqueue(job, {
   requestId: "  " }), /non-empty request id/)` and assert `queue.size` did not grow.

## Verification

- `npm test` — the three new-file tests plus the two existing files pass; `router.test.ts` must still
  see exactly one line for a `POST /reports` (job logging happens in `run()`, which that test never
  calls), which is the check that change 2 did not leak extra lines into the request path.
- Grep the module for direct writes: `grep -nE "console\.|process\.stdout" src/jobs/JobQueue.ts`
  returns nothing (r-eftp2zdb6as643np: nothing but AppLogger writes lines).

## Out of scope

- T-3 (moving AppLogger into `packages/logging`) — carried forward, untouched here.
- Log levels/filtering, a real async scheduler, retry or dead-letter behaviour for failed jobs: the
  ticket asks for start/success/failure visibility, and the drop-on-failure contract stays as it is.
