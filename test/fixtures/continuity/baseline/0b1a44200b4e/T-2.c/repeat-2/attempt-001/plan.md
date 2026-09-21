# Plan: T-2 — Make failed background jobs traceable to the originating request

## Problem

`JobQueue.run()` (`src/jobs/JobQueue.ts:33`) swallows every failure: the `catch` block
increments `failed` and drops the job. Nothing is written anywhere, so a failed job leaves
no trace at all — least of all one pointing back at the request that enqueued it. The
request id is already on the job (`QueuedJob.requestId`, set at `enqueue`), so the data
exists; nothing uses it.

## Rulings that bind this work

Both are current as of today. T-2 records no citations yet; this plan adds them to the
ticket so they reach anyone who works it later.

- **r-p19bbvh0jhj8xgma** (2026-09-15, scope logging/jobs) — "Background work carries the
  request id of the job that enqueued it. When a job runs, anything it logs is under the
  request id of the request that put it on the queue, not a fresh id." This decides the
  central design question: the failure line is logged under `job.requestId`. No new id is
  minted for the job run, and no `randomUUID()` appears in `JobQueue`.
- **r-eftp2zdb6as643np** (2026-09-14, scope logging; supersedes r-rvcf99q7dwhzzpav) —
  "One logger, AppLogger; nothing else writes log lines. Every line carries the request id
  of the work it belongs to, and secrets are redacted before the line is written." So
  `JobQueue` logs through `AppLogger.withRequestId(...)` and never through `console` or
  `process.stdout`, and error text reaches the sink only via `AppLogger`, whose `#emit`
  already redacts both message and fields.

RULES.md #1 restates the same two guarantees; #2 (Node built-ins only) is kept — the only
new import is the in-repo `AppLogger`; #3 requires a test beside the module, which is the
new `src/jobs/JobQueue.test.ts`.

## Design

`JobQueue` gains an optional `Sink`, exactly mirroring `Router`'s existing arrangement
(`src/http/router.ts:27`) so a test can observe what the queue logs while production keeps
`AppLogger`'s default sink.

1. **`src/jobs/JobQueue.ts`**
   - Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
   - `constructor(sink?: Sink)`, stored as `readonly #sink: Sink | undefined`.
   - Update the module docblock (`src/jobs/JobQueue.ts:2-3`): "Running a job does not log
     anything yet" becomes false with this change and is the file's contract documentation.
   - `enqueue` rejects a blank `requestId`. **Reversed during code review round 1** — plan
     review had dropped this guard as scope creep, on the argument that the defensive wrap
     below covers an unusable id. It does not cover it acceptably: the reviewer's probe
     showed a job enqueued with `requestId: ""` produces `{ran:0,failed:1}` and zero log
     lines, because `withRequestId` throws (`AppLogger.ts:61`) and the wrap swallows it.
     Silently discarding a failure in the background is the exact case T-2 exists to close,
     and a breach of RULES.md #1 on the failure path. The guard is a fail-fast for direct
     `JobQueue` callers; it cannot fire via HTTP, since `Router.dispatch` builds
     `AppLogger.withRequestId(req.requestId)` at `src/http/router.ts:37` before any handler
     runs, so it does not add the ISS-001 throw-escapes-dispatch shape in practice.
   - In `run()`'s `catch (err)`: build `AppLogger.withRequestId(job.requestId, this.#sink)`
     and emit one `error` line, `"background job failed"`, with fields `jobId`, `kind`, and
     `error` (the normalized failure text). Then `failed++` as today.
   - Normalize the thrown value: `err instanceof Error ? err.message : String(err)`. A
     thrown non-`Error` is not unusual and `String(err)` keeps the line useful. The stack is
     deliberately left out — noisy, and the request id plus job id is what makes the failure
     traceable.
   - The job `payload` is NOT logged. `AppLogger` would redact it, but the payload is
     arbitrary request body (`handler.ts:24` passes `req.body` straight through) and the
     ticket needs identity, not contents. Keeping it out is the smaller blast radius.
   - The `.error(...)` sink call is wrapped in its own `try`/`catch` so that a throwing sink
     cannot change `run()`'s contract: `failed` is still incremented and the remaining jobs
     still run. **Boundary narrowed in code review round 1:** the `withRequestId`
     construction stays OUTSIDE the guard. Inside it, a job with an unusable request id
     would vanish with no line and no signal, indistinguishable from a broken sink; outside
     it, that case is loud, and `enqueue`'s guard means it cannot arise in the first place.
     The existing comment "A failing job is dropped; the rest still run" (`JobQueue.ts:32`)
     stays true; it gains "and the failure is logged under the enqueuing request id".

2. **`src/http/handler.ts`**
   - The default queue is currently built in the parameter list (`queue: JobQueue = new
     JobQueue()`), before `sink` is available. Change the signature to `queue?: JobQueue`
     and resolve inside: `const jobs = queue ?? new JobQueue(sink)`. Rename the use inside
     the `POST /reports` closure (`handler.ts:24`) from `queue.enqueue` to `jobs.enqueue` —
     Node 22 strips types rather than typechecking, so a missed rename would surface only at
     runtime on a no-argument `createApp()`.
   - **Added in code review round 1:** expose the queue on the returned object as `app.jobs`
     (new exported `App` interface). Without it the default queue is unreachable — nothing
     can call `run()` on it — so the only runnable queue was a caller-supplied one, which is
     exactly the queue `createApp` does not wire to `sink`. Documenting that split was not
     enough; exposing the wired queue removes it, and makes the handler-boundary test below
     possible at all.
   - A caller-supplied queue still keeps whatever sink its owner gave it; the docblock says
     so and points at `new JobQueue(sink)` for callers who want one destination.

3. **`src/jobs/JobQueue.test.ts`** (new; RULES.md #3)
   - Per-job binding, the point of ruling r-p19bbvh0jhj8xgma: enqueue three jobs under three
     different request ids, the FIRST and THIRD failing, the second succeeding. Assert two
     error lines, each carrying its OWN job's request id and `jobId`. Ordering matters —
     pairing one leading failure with one success cannot distinguish per-job binding from a
     logger hoisted out of the loop or one reading the head of the queue. Assert
     `{ ran: 1, failed: 2 }`, i.e. today's counting semantics are untouched.
   - Secrets in the failure are redacted: a job that throws `new Error("upstream refused
     Bearer abc")` produces `"upstream refused [REDACTED]"` in the logged `error` field
     (RULES.md #1, ruling r-eftp2zdb6as643np).
   - A successful run logs nothing — the queue stays silent on the happy path.
   - A throwing sink does not change `run()`: with a sink that throws on every line, a queue
     of one failing job and one successful job still resolves to `{ ran: 1, failed: 1 }`
     rather than rejecting. This pins the swallow branch above, which is a deliberate
     behaviour decision and would otherwise ship unexercised.
   - **Added in code review round 1:** `enqueue` refuses a blank and a whitespace-only
     request id, and queues nothing.

4. **`src/http/handler.test.ts`** (new; added in code review round 1, RULES.md #3)
   `handler.ts` changes behaviour in this ticket and had no test file of its own. More
   importantly, every test in item 3 hand-feeds request ids straight to `JobQueue`, so they
   only prove the queue echoes back what it was given — a regression that passed a fresh id
   at the HTTP boundary (`handler.ts:24`, the one place a real request id crosses into a
   job) would leave all of them green. That is the ticket's actual claim, so it is tested
   where it happens:
   - `POST /reports` with a known `x-request-id`, then `app.jobs.run()` with a throwing
     runner: the failure line carries THAT request id and the `jobId` the response returned.
   - Routes and the default queue log to the same sink, in order.
   - Two requests, both jobs failing: each failure is traceable to its own request, not to
     the last one — the per-job binding of ruling r-p19bbvh0jhj8xgma, at the boundary.

## Verification

- `npm test` (Node's built-in runner, discovers every `*.test.ts`).
- `src/http/router.test.ts` asserts `lines.length === 1` for a `POST /reports`. Enqueue
  logs nothing, so that assertion must still hold — a regression there would mean the queue
  started logging on the happy path.

## Out of scope (filed separately)

`handler.ts:31` uses `req.headers["x-request-id"] ?? randomUUID()`. An empty-string header
is not nullish, so it passes through to `AppLogger.withRequestId("")`, which throws and
fails the request. Pre-existing, unrelated to job tracing; file as an issue rather than fix
it here.
