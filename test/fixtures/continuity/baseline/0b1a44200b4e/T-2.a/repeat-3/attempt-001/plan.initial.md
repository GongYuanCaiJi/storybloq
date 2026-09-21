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
- In `run()`, per job, before the `try`:
  ```ts
  const log = AppLogger.withRequestId(job.requestId, this.#sink);
  log.info("job started", { jobId: job.id, kind: job.kind });
  ```
  on success: `log.info("job succeeded", { jobId: job.id, kind: job.kind })`
  on failure, inside the existing `catch (err)`:
  `log.error("job failed", { jobId: job.id, kind: job.kind, error: errorMessage(err) })`
- Add a module-local `errorMessage(err: unknown): string` returning `err.message` for
  an `Error` and `String(err)` otherwise. The value is a plain string field, so
  `redact()` runs `redactMessage` over it and a secret inside an upstream error
  message is redacted before the line is written.
- Do **not** log `job.payload`. It is arbitrary request body; redaction is a
  backstop, not a licence to write whole payloads to the log. `kind` and `jobId`
  are what makes a job identifiable.
- The existing control flow is unchanged: a failing job is still swallowed, the
  remaining jobs still run, and `{ ran, failed }` still means what it meant.
- Update the file's header comment -- it currently states "Running a job does not
  log anything yet", which this change makes false.

### 2. `src/http/handler.ts`

`createApp(queue: JobQueue = new JobQueue(), sink?: Sink)` cannot pass `sink` into
its own default queue: a default-parameter expression may only reference parameters
declared before it, and `sink` comes after `queue`. So the default queue would log
to stdout while the routes log to the test's sink. Fix by making the parameter
optional and resolving it in the body:

```ts
export function createApp(queue?: JobQueue, sink?: Sink): { handle(...) } {
  const jobQueue = queue ?? new JobQueue(sink);
  ...
}
```

The call signature is unchanged, so `createApp(undefined, (l) => lines.push(l))` in
`src/http/router.test.ts:8` still compiles and now yields a queue on the same sink.

### 3. `src/jobs/JobQueue.test.ts` (new)

Node's built-in runner, same style as the two existing test files.

1. **Success path, enqueuing request id.** Enqueue one job with
   `{ requestId: "req-enqueued-1" }`, run a runner that resolves. Assert two lines,
   `"job started"` then `"job succeeded"`, both with `requestId === "req-enqueued-1"`,
   and `jobId`/`kind` on the fields. This is the r-p19bbvh0jhj8xgma assertion: the id
   is the enqueuing request's, not a new one.
2. **Failure path.** A runner that throws for one job. Assert a `"job started"` then
   an `error`-level `"job failed"` line carrying the error text, that the id is still
   the enqueuing one, and that `{ ran, failed }` is unchanged in meaning.
3. **Two jobs from two different requests.** Each pair of lines carries its own
   request id -- one job's lines never inherit the other's.
4. **Redaction on the failure path.** A runner throwing
   `new Error("upstream refused Bearer abc")` produces a line whose `error` field
   reads `upstream refused [REDACTED]`. This is the r-eftp2zdb6as643np assertion at
   the job boundary.

## Verification

- `npm test` (Node's runner, discovers every `*.test.ts`) -- new JobQueue tests pass
  and the existing router and AppLogger tests are untouched and still green.
- `src/http/router.test.ts` asserts exactly one line for a `POST /reports`; jobs log
  only inside `run()`, which that test never calls, so the count stays 1.
- Grep `src/jobs/` for `console.` to confirm nothing writes a log line outside
  `AppLogger`.

## Out of scope

- T-3 (move `AppLogger` to `packages/logging`) -- imports here stay pointing at
  `src/platform/logging/`.
- Job durations/timing fields, a retry policy, and any change to how failures are
  swallowed. The ticket asks for visibility, not new queue behaviour.
