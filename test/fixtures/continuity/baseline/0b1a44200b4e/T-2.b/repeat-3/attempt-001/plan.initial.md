# Plan: T-2 Add logging for background jobs

## Goal

`JobQueue.run()` currently runs jobs silently and swallows failures (`catch {}`), so a
job's start, success and failure are invisible. Make all three visible in the logs.

## Rulings that bind this work

Both are current and both are now cited by T-2:

- **r-eftp2zdb6as643np** (owner-direct, 2026-09-14, supersedes r-rvcf99q7dwhzzpav) --
  one logger, `AppLogger`; nothing else writes log lines; every line carries the request
  id of the work it belongs to; secrets redacted before the line is written.
- **r-p19bbvh0jhj8xgma** (owner-direct, 2026-09-15) -- background work logs under the
  request id of the request that enqueued it, **not** a fresh id.

Consequences for the design: no `console.*` and no second logger; the queue cannot hold
one logger for its whole lifetime, because each job carries its own `requestId` and must
log under that one. So `run()` builds an `AppLogger` **per job** from `job.requestId`.

RULES.md adds: Node built-ins only (AppLogger is local, no new dependency), and a test
beside the module named `<Module>.test.ts`.

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add an optional constructor sink, mirroring `Router`'s existing idiom
  (`constructor(sink?: Sink)`, stored in a private `#sink`) so a test can observe what
  the queue logs while production keeps `AppLogger`'s default stdout sink.
- In `run()`, per job, build `const log = AppLogger.withRequestId(job.requestId, this.#sink)`
  and emit exactly three shapes:
  - before `runner(job)`: `log.info("job started", { jobId: job.id, kind: job.kind })`
  - after it resolves: `log.info("job succeeded", { jobId: job.id, kind: job.kind })`
  - on throw: `log.error("job failed", { jobId: job.id, kind: job.kind, error: <message> })`
- Change `catch {}` to `catch (err)` and derive `error` as `err instanceof Error ? err.message : String(err)`.
  Redaction is not re-implemented here: `AppLogger` already redacts message text and every
  string field at any depth, so a secret inside a thrown error's message is redacted on the
  way out (r-eftp2zdb6as643np).
- Preserve existing behaviour exactly: a failing job is still dropped, the remaining jobs
  still run, and the return value stays `{ ran, failed }`. Logging is additive.

Field shape is kept flat and deterministic (`jobId`, `kind`, plus `error` on failure) -- no
timing field, which would make the line shape nondeterministic for no scoped benefit.

### 2. `src/http/handler.ts`

One small change so the app's default queue logs to the app's sink rather than diverging to
stdout: make the queue parameter optional (`queue?: JobQueue`) and construct the default as
`new JobQueue(sink)`. A caller that passes its own queue is unaffected, and the public
signature `createApp(queue?, sink?)` is unchanged.

### 3. `src/jobs/JobQueue.test.ts` (new, per RULES.md rule 3)

Node's built-in test runner, same style as `AppLogger.test.ts` (collect `LogLine`s into an
array via the injected sink):

1. **Success path** -- one enqueued job logs `job started` then `job succeeded`, both at
   `info`, both carrying the enqueuing request id.
2. **Failure path** -- a throwing job logs `job started` then `job failed` at `error` with
   the error message in `fields.error`; `run()` still returns `failed: 1`, and a job queued
   after it still runs and logs. Covers "a failing job is dropped, the rest still run".
3. **Per-job request id** -- two jobs enqueued under different request ids each log under
   their own id, and neither under a fresh one. This is the direct test of r-p19bbvh0jhj8xgma.
4. **Redaction on the job path** -- a job that throws an error whose message contains a
   secret-shaped token logs it as `[REDACTED]`, confirming the job path inherits
   r-eftp2zdb6as643np rather than bypassing it.

## Verification

- `npm test` (`node --test`) -- the four new tests plus the existing AppLogger and router
  tests must all pass.
- `npx tsc --noEmit` if available offline; otherwise rely on `strict` correctness by
  inspection, since the repo has no build step and no dev dependencies installed.

## Out of scope

- Moving `AppLogger` into `packages/logging` (that is T-3).
- Job retries, durations/metrics, or changing the drop-on-failure semantics.
