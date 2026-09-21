# Plan: T-2 Add logging for background jobs

## Goal

`JobQueue.run()` currently runs jobs silently and swallows failures in a bare
`catch {}`. Make each job's start, success, and failure visible in the logs.

## Rulings this plan is bound by

Both are current, and both are now cited by T-2 (the ticket cited neither when
this session picked it up, so neither would have reached a reviewer):

- **r-eftp2zdb6as643np** (current, 2026-09-14) -- one logger, `AppLogger`;
  nothing else writes log lines; every line carries the request id of the work
  it belongs to and secrets are redacted before the line is written. This
  superseded r-rvcf99q7dwhzzpav, which is the older wording and not current.
- **r-p19bbvh0jhj8xgma** (current, 2026-09-15) -- background work carries the
  request id of the request that ENQUEUED it. A running job logs under that id,
  never a fresh one.

r-p19bbvh0jhj8xgma is the load-bearing one here: `QueuedJob.requestId` already
records the enqueuing request id, so the logger for a job must be bound to
`job.requestId` and not to any id minted at run time.

## Approach

Mirror the pattern `Router` already uses, so there is one way to log in this
codebase rather than two.

1. **`src/jobs/JobQueue.ts`**
   - Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
   - Add a constructor taking an optional `sink?: Sink`, stored as `#sink`,
     with the same doc-comment rationale as `Router`'s: a test can observe what
     jobs log; production falls through to `AppLogger`'s default sink. The
     parameter is optional, so `new JobQueue()` keeps working unchanged.
   - In `run()`, per job, build `AppLogger.withRequestId(job.requestId, this.#sink)`.
     One logger per job, bound to that job's own enqueuing request id --
     a single queue-level logger cannot satisfy r-p19bbvh0jhj8xgma because
     different jobs in the same queue carry different request ids.
   - Emit three lines:
     - before `runner(job)`: `log.info("job started", { jobId: job.id, kind: job.kind })`
     - after it resolves: `log.info("job succeeded", { jobId: job.id, kind: job.kind, durationMs })`
     - on throw: `log.error("job failed", { jobId: job.id, kind: job.kind, durationMs, error: <message> })`
   - `durationMs` is `Date.now()` around the `await`.
   - The `catch` keeps its current behaviour -- the failure is logged, the job
     is still dropped, remaining jobs still run, and `{ ran, failed }` counts
     are unchanged. This ticket adds visibility, it does not change job
     semantics.
   - The caught value is narrowed: `err instanceof Error ? err.message : String(err)`.
     A non-Error throw must not produce `undefined` in the log line.

2. **Never log `job.payload`.** The payload is the caller's request body
   (`POST /reports` passes `req.body` straight through). `AppLogger.redact`
   would catch secrets by key and by shape, but an arbitrary payload is exactly
   where an unrecognised secret shape would slip past, and RULES.md rule 1 is
   absolute. `jobId` and `kind` identify the job without carrying its contents.
   Redaction still applies to everything that IS logged -- notably the error
   message, which can quote upstream text containing a token.

3. **`src/http/handler.ts`** -- when `createApp` builds its own default queue,
   pass the sink through: `queue: JobQueue = new JobQueue(sink)` is not valid
   (parameter order), so default the parameter to `undefined` and construct
   `const jobQueue = queue ?? new JobQueue(sink)`. A caller-supplied queue is
   left exactly as supplied -- it owns its own sink. Without this, jobs run by
   the default queue would write to stdout during tests that pass a sink.

4. **`src/jobs/JobQueue.test.ts`** (new; RULES.md rule 3 -- `<Module>.test.ts`
   beside the module). Node's built-in runner, `node:test` + `node:assert/strict`,
   matching the existing two test files. Cases:
   - A job that succeeds emits `job started` then `job succeeded`, both with
     `requestId` equal to the id the job was ENQUEUED under -- the direct test
     of r-p19bbvh0jhj8xgma.
   - Two jobs enqueued under different request ids log under their own ids
     respectively, not a shared one.
   - A throwing job emits `job failed` at level `error`, the queue still
     returns `{ ran: 1, failed: 1 }` for a mixed batch, and the surviving job
     still runs.
   - A job whose thrown error message embeds a secret-shaped token
     (`"upstream refused Bearer abc"`) is redacted in the emitted line --
     RULES.md rule 1 through the new path.
   - The payload is not present in any emitted field.

## Files touched

| File | Change |
|---|---|
| `src/jobs/JobQueue.ts` | optional sink, per-job logger, three log lines, narrowed error |
| `src/http/handler.ts` | pass the sink into the default queue only |
| `src/jobs/JobQueue.test.ts` | new, five cases |

## Verification

`npm test` (`node --test`) -- the two existing test files must stay green;
`router.test.ts` asserting `lines.length === 1` for `POST /reports` is the
canary that enqueue itself still logs nothing extra.

## Out of scope

- T-3 (moving `AppLogger` into `packages/logging`) -- carried forward, untouched.
- No new dependency (RULES.md rule 2); `node:test`, `node:assert` and the
  existing logger are all that is used.
- Retry/backoff for failed jobs: not asked for, and it would change the job
  semantics this plan deliberately preserves.
