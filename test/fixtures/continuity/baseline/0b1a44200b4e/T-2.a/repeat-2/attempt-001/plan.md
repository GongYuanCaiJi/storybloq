# Plan: T-2 Add logging for background jobs

## Ticket

T-2 (task, phase p1, risk low): Background jobs run without any log output today. Add logging for
background jobs in `src/jobs/` so that a job's start, success and failure are visible in the logs.

## Rulings that bind this work

T-2 recorded no `citesRulings` when this plan was drafted. Two CURRENT rulings nevertheless govern
every line this ticket adds, so step 0 cited them on the ticket (already done — see step 0) and they
now reach the review stages and any later agent rather than those being told there is nothing:

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
2b. r-p19bbvh0jhj8xgma says "**anything** it logs", which reaches past the three lines `JobQueue`
   emits itself and into what the runner logs. A runner that mints its own id violates the ruling
   while a queue-only test stays green, so change 1b below hands the runner the already-bound
   logger, exactly as `Router` hands `RouteHandler` its logger instead of trusting it to build one.
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

### 0. Cite the rulings on T-2 (ledger, no code) — DONE

`storybloq_ticket_update` with `citesRuling: ["r-eftp2zdb6as643np", "r-p19bbvh0jhj8xgma"]` — the two
current ids above. This is what delivers them into the plan-review and code-review packets. Already
applied during the PLAN step; `.story/tickets/T-2.json` carries both ids. Nothing left to do here.

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
  Failing at enqueue keeps the unloggable job out of the queue and fails at the call site that
  actually knows the request, instead of mid-drain.
  **What this guard is and is not.** It is a defensive contract check on `JobQueue`'s public API,
  for direct non-HTTP callers (tests, future schedulers, anything constructing a queue itself). It
  is NOT closing a live gap on the HTTP path: `Router.dispatch` builds `AppLogger.withRequestId`
  (router.ts:37) before any route body runs, so a blank id already throws there and never reaches
  `queue.enqueue`. The genuinely reachable hole is upstream — handler.ts:31 uses
  `req.headers["x-request-id"] ?? randomUUID()`, and `??` does not catch `""`. That is pre-existing,
  lives in `src/http/`, and is out of scope for a ticket scoped to `src/jobs/`; it is filed as
  **ISS-001** rather than fixed here.
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
- **No `finally`.** "job succeeded" is emitted on the success path only, after `await runner(job)`
  returns. Putting it in a `finally` would log a failed job as succeeded — the exact opposite of
  what this ticket exists to make visible. Test 2 below pins the whole line sequence so this cannot
  regress silently.
- Update the file's header comment, which currently states "Running a job does not log anything yet."

### 1b. `JobRunner` receives the bound logger (same file)

Widen the runner type to mirror `RouteHandler`:
`export type JobRunner = (job: QueuedJob, log: AppLogger) => Promise<void> | void;`
and pass the per-job logger built above: `await runner(job, log)`.

Why: constraint 2b. `Router` does not trust a handler to build its own logger, it hands one down,
and that is what makes "every line carries the right id" structural rather than a convention. Under
the narrower signature a runner's path of least resistance is `AppLogger.withRequestId(randomUUID())`,
which violates r-p19bbvh0jhj8xgma while every queue-level test stays green.

This is backward compatible: in TypeScript a function accepting fewer parameters is assignable to a
type declaring more, so existing `(job) => ...` runners keep compiling untouched. `AppLogger` is
imported as a value already (change 1), so no import-only change is needed.

### 2. `src/http/handler.ts` — DROPPED, deliberately

The earlier draft proposed `createApp(queue?, sink?)` with `const jobs = queue ?? new JobQueue(sink)`
so an injected sink would reach the default queue. Cut: `createApp` returns only `{ handle }`, never
exposes the queue, and `JobQueue.run()` has zero callers in `src` (verified by grep), so the default
queue is never drained and no test could observe the change. It would be a signature change with no
test in its own directory, which RULES.md #3 forbids.

Choosing explicitly between the two options the review named: take (a), drop it. The alternative (b)
— returning the queue or a `drain()` from `createApp` so an end-to-end HTTP→enqueue→run test could
assert the id survives — widens `createApp`'s public API to serve a caller that does not exist yet,
which is a design decision this ticket should not make on its own. `src/http/handler.ts` is therefore
**not modified at all** by T-2. Recorded under Out of scope.

### 3. `src/jobs/JobQueue.test.ts` (new)

Node's built-in runner, `import test from "node:test"` / `assert from "node:assert/strict"`, matching
the existing two test files.

1. **start and success are logged under the enqueuing request id** — enqueue one job with
   `requestId: "req-job-1"`, `run()` a resolving runner, assert EXACTLY two lines, both
   `requestId === "req-job-1"`, messages `"job started"` then `"job succeeded"` in that order.
   Assert the field set is CLOSED, not merely that the expected keys are present:
   `assert.deepEqual(line.fields, { jobId: "job-1", kind: "report" })` (and exactly
   `{ jobId, kind, error }` on the failure line in test 2). A closed set is what pins the
   "`job.payload` is deliberately not logged" decision from change 1 — an open check leaves it
   unpinned, and `payload` is caller-controlled `unknown` that on the HTTP path is literally
   `req.body` (handler.ts:24). `redact()` only catches secret-SHAPED values or secret-NAMED keys, so
   a secret sitting under a neutral key inside a payload would reach the line unredacted. Asserts
   both rulings directly.
2. **a failing job logs a failure, and the rest still run** — two jobs with DIFFERENT request ids
   (`"req-job-a"`, `"req-job-b"`), the first runner throwing. Assert `{ ran: 1, failed: 1 }`, and
   assert the FULL LINE SEQUENCE, not just that a failure line exists somewhere:

   ```
   [ {requestId: "req-job-a", level: "info",  message: "job started"},
     {requestId: "req-job-a", level: "error", message: "job failed"},
     {requestId: "req-job-b", level: "info",  message: "job started"},
     {requestId: "req-job-b", level: "info",  message: "job succeeded"} ]
   ```

   — four lines, in that order, plus `fields.error` on the failure line carrying the thrown message.
   Two failure modes ride on this one assertion and neither is caught by an existence-only check:
   a `finally`-emitted success line would append a fifth `"job succeeded"` under `req-job-a`, and
   the differing request ids catch a queue-level or per-`run()` logger (which would pass test 1).
   The order also pins the drain-order guarantee change 1 claims is unchanged — nothing else does.
3. **secrets in a job failure are redacted** — exact fixture, chosen against AppLogger's actual
   patterns: the runner throws `new Error("upstream refused Bearer abc-secret for job")` and the
   assertion is `fields.error === "upstream refused [REDACTED] for job"`. The embedded shape is used
   deliberately: `SECRET_VALUE` is anchored (`^...$`) and so yields a bare `"[REDACTED]"`, whereas
   `SECRET_IN_TEXT` splices within surrounding text, which is what a real thrown message looks like.
   Note a short token such as `sk-123` is NOT redacted (the pattern requires 8+ chars), so it must
   not be used as a fixture here. Guards the redaction half of r-eftp2zdb6as643np on the new path.
4. **a job cannot be enqueued without a request id** — `assert.throws(() => queue.enqueue(job, {
   requestId: "  " }), /non-empty request id/)` and assert `queue.size` did not grow.
5. **the runner is handed a logger bound to the job's request id** (change 1b) — a runner that calls
   `log.info("runner line")`. Assert from OUTSIDE the runner: `{ ran: 1, failed: 0 }`, and the exact
   three-line sequence `"job started"` / `"runner line"` / `"job succeeded"`, every line under the
   job's own request id. The outer assertions are the real ones and the `{ ran: 1, failed: 0 }` check
   is load-bearing: `run()` swallows anything the runner throws, so an `assert` placed INSIDE the
   runner cannot fail the test on its own — a wrong id would be silently converted into a
   `"job failed"` line and the test would still pass. An in-runner
   `assert.equal(log.requestId, job.requestId)` may be kept as documentation, but never as the only
   check. This is what makes r-p19bbvh0jhj8xgma structural for runner-internal logging rather than a
   convention.

## Verification

- `npm test` — the five new tests plus the two existing files pass. `router.test.ts` must still see
  exactly one line for a `POST /reports`; with change 2 dropped, `src/http/` is untouched, so any
  movement there is a real regression rather than an expected adjustment.
- **Typecheck.** `node --test` strips types without checking them, so tests alone would not catch a
  type error under `tsconfig.json`'s `strict: true` — relevant to the new constructor signature, the
  `Sink | undefined` field, the widened `JobRunner`, and the `catch (err)` narrowing. Run
  `tsc --noEmit -p tsconfig.json` (`noEmit` is already set in the config). TypeScript is not a
  project dependency and RULES.md #2 keeps it that way — this is a local verification step, not a new
  dependency, so if no `tsc` is reachable, say so in the report rather than silently skipping it, and
  hand-check those four sites instead.
- Grep the module for direct writes: `grep -nE "console\.|process\.stdout" src/jobs/JobQueue.ts`
  returns nothing (r-eftp2zdb6as643np: nothing but AppLogger writes lines).

## Out of scope

- **`src/http/handler.ts` entirely** — see change 2 above. Wiring a sink into the app-level queue,
  and exposing the queue or a `drain()` from `createApp`, wait for a caller that actually drains it.
- **ISS-001** (blank `x-request-id` header throws out of `app.handle`) — pre-existing, filed during
  this plan review, lives in `src/http/`.
- T-3 (moving AppLogger into `packages/logging`) — carried forward, untouched here.
- Log levels/filtering, a real async scheduler, retry or dead-letter behaviour for failed jobs: the
  ticket asks for start/success/failure visibility, and the drop-on-failure contract stays as it is.
