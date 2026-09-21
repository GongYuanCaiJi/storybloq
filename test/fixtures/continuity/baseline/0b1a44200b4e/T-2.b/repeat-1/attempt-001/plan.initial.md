# Plan: T-2 Add logging for background jobs

## Goal

`JobQueue.run()` currently logs nothing: a job's start, success and failure are invisible.
Make all three visible in the logs, without breaking the two guarantees the logging path
already holds.

## Rulings this ticket cites

Both are current (named by current id, as the plan gate requires):

- **r-eftp2zdb6as643np** (current; supersedes r-rvcf99q7dwhzzpav) -- "Logging keeps
  redaction and request ids on every path. One logger, AppLogger; nothing else writes log
  lines. Every line carries the request id of the work it belongs to, and secrets are
  redacted before the line is written."
- **r-p19bbvh0jhj8xgma** -- "Background work carries the request id of the job that
  enqueued it. When a job runs, anything it logs is under the request id of the request
  that put it on the queue, not a fresh id."

Consequences that shape the design, not just decoration:

1. No `console.*`, no `process.stdout.write`, no second logger inside `JobQueue`. Every
   line goes through `AppLogger`.
2. The logger is bound **per job**, to `job.requestId` -- not per queue, and never a fresh
   id. `JobQueue.run()` drains jobs from many different requests, so one logger for the
   whole run would stamp the wrong id on most lines. This is the single most important
   detail in the ticket and the thing a reviewer should check first.
3. Failure logging must not defeat redaction: the error goes through `AppLogger`'s fields,
   which redacts at any depth, rather than being string-concatenated into the message by
   hand. (`AppLogger` redacts message text too, but fields are the honest channel.)

RULES.md adds: Node built-ins only (satisfied -- no new imports), and a behaviour change
comes with a test named `<Module>.test.ts` beside the module (`src/jobs/JobQueue.test.ts`,
which does not exist yet).

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add an optional sink to the constructor, mirroring `Router`'s existing shape
  (`constructor(sink?: Sink)`, stored in a `#sink` private field) so a test can observe
  what jobs log and production keeps `AppLogger`'s default sink. This is the pattern the
  codebase already uses in `src/http/router.ts`; no new mechanism is introduced.
- In `run()`, per job, build `AppLogger.withRequestId(job.requestId, this.#sink)` inside
  the loop and emit:
  - before `await runner(job)` -- `log.info("job started", { jobId: job.id, kind: job.kind })`
  - on success -- `log.info("job succeeded", { jobId: job.id, kind: job.kind })`
  - in `catch (err)` -- `log.error("job failed", { jobId: job.id, kind: job.kind, error: message(err) })`
    where `message(err)` is a tiny local helper returning `err instanceof Error ? err.message : String(err)`.
    The `catch` keeps its current behaviour otherwise: the failing job is dropped, the
    counters still increment, and the remaining jobs still run. The catch binding changes
    from bare `catch {` to `catch (err) {`.
- Do **not** log the job payload. It is arbitrary caller data (`payload: unknown`, fed
  straight from an HTTP request body in `handler.ts`). `redact()` would cover the shapes it
  knows, but the smaller line is the safer one and `kind` plus `jobId` already identify the
  job. Recorded here because it is a deliberate choice a reviewer might otherwise read as
  an omission.

### 2. `src/http/handler.ts`

`createApp` builds a default `new JobQueue()` that would silently keep the default sink
even when the caller passed one, so a test's sink would see route lines but no job lines.
Thread it through: make the `queue` parameter optional and resolve it in the body as
`const jobs = queue ?? new JobQueue(sink)`. A queue passed in by the caller is left exactly
as it is -- it owns its own sink.

This cannot be done with a default parameter value (`queue = new JobQueue(sink)`), because
parameters are evaluated left to right and `sink` is not initialised yet at that point.
`router.test.ts` already calls `createApp(undefined, sink)`, so the optional-parameter
shape stays source-compatible with the existing call site.

### 3. `src/jobs/JobQueue.test.ts` (new)

Node's built-in test runner, `node:test` + `node:assert/strict`, matching the two existing
test files:

1. **start / success / failure are all visible, under the enqueuing request id.** Enqueue
   two jobs under two *different* request ids, run with a runner that succeeds for the
   first and throws for the second. Assert: four lines; `job started` + `job succeeded` for
   the first under its own request id; `job started` + `job failed` for the second under
   *its* request id; the failure line is `level: "error"` and carries the thrown message.
   The differing ids are the point -- a per-queue logger would pass a single-id test.
2. **Failure does not stop the queue, and the return value is unchanged.** Three jobs where
   the middle one throws; assert `{ ran: 2, failed: 1 }` and that the third job's lines are
   present -- the existing contract, now pinned by a test.
3. **A secret in a job's failure is redacted before it is written.** A runner that throws
   `new Error("upstream refused Bearer abc")`; assert the emitted `error` field contains
   `[REDACTED]` and not `Bearer abc`. This is the ruling's redaction guarantee holding on
   the new path, which is exactly the path that did not exist before.

## Verification

- `npm test` -- the two existing test files plus the new one, all passing.
- `npx --no-install tsc --noEmit` if a local TypeScript is available; skip rather than
  install, since RULES.md keeps the project dependency-free.

## Out of scope

- T-3 (moving `AppLogger` into `packages/logging`) -- imports here will move with it.
- Any change to `AppLogger` itself. The redaction and request-id machinery already does
  what this ticket needs; touching it would put T-1's guarantees back in review for no gain.
