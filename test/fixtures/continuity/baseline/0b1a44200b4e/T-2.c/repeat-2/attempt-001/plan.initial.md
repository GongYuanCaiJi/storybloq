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
   - `enqueue` rejects a blank `requestId` (`opts.requestId.trim() === ""` → throw). A job
     that cannot name its originating request is untraceable by construction, and this is
     the boundary where that can still be said cheaply. It also means the `AppLogger`
     construction in `run()` cannot throw for lack of an id. Only caller today is
     `handler.ts`, which always passes a non-empty id.
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
   - The whole logging step is wrapped so that a throwing sink cannot change `run()`'s
     contract — `failed` is still incremented and the remaining jobs still run. The existing
     comment "A failing job is dropped; the rest still run" stays true; it gains "and the
     failure is logged under the enqueuing request id".

2. **`src/http/handler.ts`**
   - The default queue is currently built in the parameter list (`queue: JobQueue = new
     JobQueue()`), before `sink` is available. Change the signature to `queue?: JobQueue`
     and resolve inside: `const jobs = queue ?? new JobQueue(sink)`. A caller-supplied queue
     is left alone — it carries whatever sink its owner gave it.

3. **`src/jobs/JobQueue.test.ts`** (new; RULES.md #3)
   - A failing job logs exactly one `error` line whose `requestId` is the id of the request
     that enqueued it (not a fresh one), carrying `jobId` and `kind`; a second, successful
     job enqueued under a different request id still runs, and `{ ran, failed }` is unchanged
     from today's semantics.
   - Secrets in the failure are redacted: a job that throws `new Error("upstream refused
     Bearer abc")` produces `"upstream refused [REDACTED]"` in the logged `error` field
     (RULES.md #1, ruling r-eftp2zdb6as643np).
   - A successful run logs nothing — the queue stays silent on the happy path.
   - `enqueue` with a blank request id throws.

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
