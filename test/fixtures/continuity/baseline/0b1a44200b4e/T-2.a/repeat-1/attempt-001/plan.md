# Plan: T-2 Add logging for background jobs

> Revised after plan review rounds 1 and 2 (agent review; codex bridge
> unavailable). Changes from round 1 are marked **[r1]**, from round 2 **[r2]**.

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

**[r1] The ruling says "anything it logs", not "anything the queue logs".** The
runner is what actually performs the job, so it is the main thing a job logs
from. Round 1 was right that binding only the queue's own three lines leaves
the runner to mint its own logger with no access to the queue's sink -- which
is both unenforced and untestable. The fix is below in step 2.

## Approach

Mirror the pattern `Router` already uses, so there is one way to log in this
codebase rather than two.

1. **`src/jobs/JobQueue.ts` -- the sink**
   - Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
   - Add a constructor taking an optional `sink?: Sink`, stored as `#sink`,
     with the same doc-comment rationale as `Router`'s: a test can observe what
     jobs log; production falls through to `AppLogger`'s default sink. The
     parameter is optional, so `new JobQueue()` keeps working unchanged --
     including the `new JobQueue()` default in `createApp`.

2. **[r1] `src/jobs/JobQueue.ts` -- hand the logger to the runner**
   - Widen the runner type to `(job: QueuedJob, log: AppLogger) => Promise<void> | void`,
     exactly mirroring `RouteHandler`'s `(req, log)` (src/http/router.ts:20),
     and pass the per-job logger as the second argument at the call site.
   - This is what actually puts job-body logging under the ruling: a runner
     receives a logger already bound to the enqueuing request id and already
     wired to the queue's sink, so the compliant path is the default path
     rather than something each runner author must remember.
   - Safe to widen: nothing in the repo implements `JobRunner` or calls
     `run()` today (verified by grep over `src/` -- the only `JobQueue`
     references are its own definition and the `createApp` default). Adding a
     parameter is source-compatible for any runner that ignores it.

3. **`src/jobs/JobQueue.ts` -- the lines**
   - In `run()`, per job, build `AppLogger.withRequestId(job.requestId, this.#sink)`.
     One logger per job, bound to that job's own enqueuing request id --
     a single queue-level logger cannot satisfy r-p19bbvh0jhj8xgma because
     different jobs in the same queue carry different request ids.
   - Emit three lines:
     - before `runner(job, log)`: `log.info("job started", { jobId: job.id, kind: job.kind })`
     - after it resolves: `log.info("job succeeded", { jobId: job.id, kind: job.kind, durationMs })`
     - on throw: `log.error("job failed", { jobId: job.id, kind: job.kind, durationMs, error: <message> })`
   - `durationMs` is `Date.now()` around the `await`.
   - The caught value is narrowed: `err instanceof Error ? err.message : String(err)`.
     A non-Error throw must not produce `undefined` in the log line.
   - **[r2] The logger is built ABOVE the `try`, and `enqueue` validates the
     request id instead.** Round 2 was right that round 1's answer was a
     regression dressed as a no-op: `AppLogger.withRequestId` throws on a blank
     id (AppLogger.ts:61), so putting construction as the first statement
     inside the `try` means a job with `requestId: ""` is never handed to the
     runner at all -- a job that today RUNS and is counted in `ran`
     (JobQueue.ts:36-44) would stop running, be counted `failed`, and emit
     nothing. That is a silent regression and the opposite of this ticket's
     goal. It also does not compile as described: a `const log` inside the
     `try` is out of scope in the `catch` that needs it.
   - The fix is at the boundary. **`enqueue` rejects a blank request id**:
     `if (opts.requestId.trim() === "") throw new Error("JobQueue requires a non-empty request id")`,
     mirroring AppLogger's own guard and message. Every job on the queue then
     carries a usable id by construction, so `run()` can build the logger above
     the `try` where the `catch` can see it, and construction cannot throw.
   - **This is a deliberate behaviour change to `enqueue`, and it is stated as
     one rather than filed under "no semantic change".** It adds no new failure
     mode to the HTTP path: `Router.dispatch` builds its logger at router.ts:37
     BEFORE route lookup, so a request with a blank id already throws there and
     never reaches the `/reports` route that calls `enqueue`. The change turns
     "accept an unusable id silently, fail confusingly later" into "refuse it
     where the caller still has the request context", which is the direction
     ISS-003 argues for at the other end of the same path.
   - Minting a substitute id was never an option: r-p19bbvh0jhj8xgma forbids a
     running job logging under a fresh id.
   - The `catch` otherwise keeps its current behaviour -- failure logged, job
     dropped, remaining jobs run, `{ ran, failed }` counts unchanged. **[r2]**
     `run()`'s job semantics are unchanged; the one deliberate behaviour change
     in this ticket is `enqueue`'s new guard above, and it is tested.
   - Update the module doc-comment at JobQueue.ts:1-4, whose last sentence
     ("Running a job does not log anything yet.") this change falsifies. **[r1]**

4. **Never log `job.payload`.** The payload is the caller's request body
   (`POST /reports` passes `req.body` straight through). `AppLogger.redact`
   would catch secrets by key and by shape, but an arbitrary payload is exactly
   where an unrecognised secret shape would slip past, and RULES.md rule 1 is
   absolute. `jobId` and `kind` identify the job without carrying its contents.
   Redaction still applies to everything that IS logged -- notably the error
   message, which can quote upstream text containing a token.

5. **[r1] `src/http/handler.ts` is NOT touched.** Round 1's step 3 proposed
   threading the sink into `createApp`'s default queue, justified by "otherwise
   those jobs write to stdout during tests that pass a sink". That rationale is
   false against the current code: `createApp` returns only `{ handle }`
   (handler.ts:29-34) and never exposes the queue, and nothing calls
   `JobQueue.run()`, so a default-constructed queue can never run a job. The
   change would have had no observable effect, no test could exercise it, and
   it would have been a behaviour change to a module with no `handler.test.ts`
   (RULES rule 3, filed as ISS-001). Dropping it also removes the
   `queue.enqueue` / `queue?: JobQueue` strict-mode typecheck gap round 1
   flagged. When a real runner arrives and `createApp` needs to run jobs, the
   wiring belongs in that ticket, with its test.

6. **`src/jobs/JobQueue.test.ts`** (new; RULES.md rule 3 -- `<Module>.test.ts`
   beside the module). Node's built-in runner, `node:test` + `node:assert/strict`,
   matching the existing two test files. Cases:
   - A job that succeeds emits `job started` then `job succeeded`, both with
     `requestId` equal to the id the job was ENQUEUED under -- the direct test
     of r-p19bbvh0jhj8xgma.
   - Two jobs enqueued under different request ids log under their own ids
     respectively, not a shared one.
   - **[r1]** The logger handed to the runner is bound to that job's enqueuing
     request id and writes to the queue's sink: the runner logs its own line
     and the test asserts that line's `requestId` and its presence in the
     captured sink output. This is the test that step 2 exists for.
   - A throwing job emits `job failed` at level `error`, the queue still
     returns `{ ran: 1, failed: 1 }` for a mixed batch, and the surviving job
     still runs.
   - A job whose thrown error message embeds a secret-shaped token
     (`"upstream refused Bearer abc"`) is redacted in the emitted line --
     RULES.md rule 1 through the new path.
   - The payload is not present in any emitted field.
   - **[r2]** `enqueue` throws on a blank or whitespace-only request id, and a
     queue that never accepted it still runs its other jobs normally.
   - **[r2]** A failing job emits `job started` BEFORE `job failed` -- the start
     line is not lost when the runner throws.
   - **[r2]** A runner that throws a non-Error (`throw "boom"`) still produces a
     string `error` field, covering the `String(err)` branch of the narrowing.
   - **[r1] Assertion style:** `durationMs` is wall-clock, so the success and
     failure lines are asserted key-wise -- `assert.ok(!("payload" in fields))`,
     `assert.equal(fields.jobId, "job-1")`, `assert.equal(typeof fields.durationMs, "number")`
     -- never `assert.deepEqual` over the whole `fields` object, which would be
     timing-dependent. The `job started` line carries no duration and may be
     deep-equalled.

## Files touched

| File | Change |
|---|---|
| `src/jobs/JobQueue.ts` | optional sink, logger passed to runner, per-job logger above the try, three log lines, narrowed error, **[r2]** blank-request-id guard in `enqueue`, doc-comment refreshed |
| `src/jobs/JobQueue.test.ts` | new, ten cases |

**[r1]** `src/http/handler.ts` was in this table in round 1 and has been removed
(step 5).

## Verification

`npm test` (`node --test`) -- the two existing test files must stay green;
`router.test.ts` asserting `lines.length === 1` for `POST /reports` is the
canary that enqueue itself still logs nothing extra. With handler.ts no longer
touched, that file's behaviour is unchanged by this ticket.

## Out of scope

- T-3 (moving `AppLogger` into `packages/logging`) -- carried forward, untouched.
- No new dependency (RULES.md rule 2); `node:test`, `node:assert` and the
  existing logger are all that is used.
- Retry/backoff for failed jobs: not asked for, and it would change the job
  semantics this plan deliberately preserves.
- **[r1]** The `??` empty-request-id hazard at handler.ts:31 and the missing
  `src/http/handler.test.ts` (ISS-001): both pre-existing, both filed as issues.
