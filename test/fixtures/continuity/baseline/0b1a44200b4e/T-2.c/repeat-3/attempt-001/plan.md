# Plan: T-2 — Make failed background jobs traceable to the originating request

## Problem

`JobQueue.run()` (src/jobs/JobQueue.ts:41) swallows every failure:

```ts
} catch {
  failed++;
}
```

The queue already records the enqueuing request id on each job (`QueuedJob.requestId`,
set in `enqueue`), so the trace data exists — nothing ever emits it. A failed job is
counted and dropped, and there is no way to get from that count back to the request
that caused it.

## Rulings this ticket cites

Both are current (neither is superseded); both are now cited on T-2.

- **r-p19bbvh0jhj8xgma** (owner, 2026-09-15) — "Background work carries the request id
  of the job that enqueued it. When a job runs, anything it logs is under the request id
  of the request that put it on the queue, not a fresh id." This is the ruling that
  decides the design: the failure line is emitted under `job.requestId`, never a fresh
  id and never the id of whatever triggered `run()`.
- **r-eftp2zdb6as643np** (owner, 2026-09-14) — "One logger, AppLogger; nothing else
  writes log lines. Every line carries the request id of the work it belongs to, and
  secrets are redacted before the line is written." So the failure line goes through
  `AppLogger`, not `console` and not a bespoke sink call.

RULES.md adds: Node built-ins only (2), and a behaviour change ships with a
`<Module>.test.ts` beside it (3).

## Design

`JobQueue` gains an optional `Sink`, mirroring how `Router` already takes one
(src/http/router.ts:27) so a test can observe what is logged while production uses
`AppLogger`'s default sink. Per failing job, `run()` builds
`AppLogger.withRequestId(job.requestId, sink)` and emits one `error` line.

A logger is built per job rather than once per `run()` because each job carries its own
request id — that is exactly what r-p19bbvh0jhj8xgma requires. Construction is cheap
(a two-field object).

That logger is also **passed to the runner** as a second argument, the way `Router`
hands each route handler a pre-bound `log` (src/http/router.ts:37,43). r-p19bbvh0jhj8xgma
says *anything* a running job logs is under the enqueuing request's id; if the runner
has to build its own logger, `AppLogger.withRequestId(randomUUID(), …)` is exactly as
easy as the correct call, and that is the fresh id the ruling forbids. Widening
`JobRunner` to `(job, log) => …` is backward-compatible — a one-parameter function
stays assignable — and closes the half of the ruling that failure logging alone does
not reach.

Redaction needs no new code: a thrown error's message can contain a secret
(`"upstream refused Bearer abc"`), and `AppLogger#emit` already runs `redactMessage` on
the message and `redact` on the fields, including string values under neutral keys at
any depth. Passing the error text as a field value puts it through that path. The
existing `AppLogger.test.ts` case at line 17 covers exactly this shape.

**Scope:** failure logging only. The ticket is about failed jobs; successful jobs stay
silent, as they are today. Nothing about the `{ ran, failed }` return, the ordering, or
the "a failing job is dropped, the rest still run" contract changes.

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Constructor takes `sink?: Sink`, held in a private field (same shape as `Router`).
- `JobRunner` becomes `(job: QueuedJob, log: AppLogger) => Promise<void> | void`, and
  `run()` builds the job's logger before invoking the runner, passing it in.
- `enqueue` rejects an empty/whitespace request id with a thrown error. Reason: the
  logger requires a non-empty id (AppLogger.ts:61), and if that throw happened inside
  `run()`'s catch it would escape the loop and abandon every remaining job — turning a
  single job's failure into a lost queue. Validating at enqueue keeps `run()` total,
  and refusing an untraceable job at the door is the same guarantee RULES.md #1 makes.
- `run()`'s catch logs before counting:

```ts
const log = AppLogger.withRequestId(job.requestId, this.#sink);
try {
  await runner(job, log);
  ran++;
} catch (err) {
  log.error("job failed", {
    jobId: job.id,
    kind: job.kind,
    error: err instanceof Error ? err.message : String(err),
  });
  failed++;
}
```

  The `err instanceof Error` coercion is there because a job may throw a non-Error.
  The stack is deliberately left out: the message is what identifies the failure, and
  a stack adds filesystem paths to every line without helping the trace.

### 2. `src/http/handler.ts`

`createApp(queue: JobQueue = new JobQueue(), sink?: Sink)` builds its default queue
without the sink, so a caller passing only a sink (which is what router.test.ts does)
would get a queue that logs nowhere observable. Change the default to be resolved in
the body:

```ts
export function createApp(queue?: JobQueue, sink?: Sink) {
  const jobQueue = queue ?? new JobQueue(sink);
```

The route body at src/http/handler.ts:24 must be updated to `jobQueue.enqueue(...)` in
the same edit. Left as `queue.enqueue(...)` the parameter is now `JobQueue | undefined`,
and since `npm test` runs Node's type stripping without a typecheck it would not be a
compile error but a `TypeError` on every `POST /reports` that did not pass a queue —
which is the case router.test.ts:8 exercises.

The signature stays source-compatible — `queue` was already optional and already called
as `createApp(undefined, sink)`. A caller that supplies its own queue owns that queue's
sink; only the default queue is wired up here.

### 3. `src/jobs/JobQueue.test.ts` (new)

Per RULES.md #3, beside the module. Five tests:

1. **A failed job logs under the request id that enqueued it.** Enqueue three jobs with
   different request ids, fail the first and the third; assert two lines whose
   `requestId`s are the first and third jobs' own ids, in order, each `error` level with
   `jobId` and `kind` in fields. Two failures rather than one so the assertion also
   catches a logger hoisted out of the loop and bound once, which a single-failure test
   would pass. This is the r-p19bbvh0jhj8xgma assertion.
2. **The rest of the queue still runs and the counts hold.** The same run returns
   `{ ran: 1, failed: 2 }` and the middle job's runner was invoked — the existing
   "a failing job is dropped, the rest still run" contract is not regressed.
3. **The runner is handed a logger bound to the job's own request id.** Capture the
   `log` argument, emit from it, assert the line's `requestId` is the enqueuing
   request's — the "not a fresh id" half of r-p19bbvh0jhj8xgma.
4. **A secret in the failure reason is redacted.** Throw `new Error("upstream refused
   Bearer abc")`; assert the logged `error` field is `"upstream refused [REDACTED]"`.
   RULES.md #1.
5. **`enqueue` refuses an empty or whitespace-only request id**, so no untraceable job
   can be queued. Whitespace as well as empty, matching `AppLogger.withRequestId`'s own
   `requestId.trim() === ""` guard (src/platform/logging/AppLogger.ts:61), which is the
   guard this validation exists to keep `run()` away from.

### 4. `src/http/handler.test.ts` (new)

The `handler.ts` change is a behaviour change, so RULES.md #3 wants a test beside it —
and `createApp` returns only `{ handle }`, so nothing about the queue wiring is
observable through the existing router test beyond "nothing extra was logged".

One end-to-end test, which is the ticket's actual claim: `POST /reports` with
`x-request-id: req-http-9`, then fail that job in `run()`, and assert the failure line
carries `req-http-9`. It passes its own `new JobQueue(sink)` into `createApp`, so it
proves the whole path — id born at the HTTP edge, recorded at enqueue, emitted on
failure — rather than the default-queue branch specifically.

Honest limit, recorded rather than papered over: the `queue ?? new JobQueue(sink)`
branch for the *default* queue stays unexercised, because `createApp` never exposes the
queue it builds and no production code calls `run()` yet. It is forward-wiring so that
the default queue logs somewhere the caller chose; widening `createApp`'s return type
to expose the queue would be a larger API change than this ticket needs.

## Verification

- `npm test` — the 4 existing tests plus the 6 new ones pass.
- The existing router test is the regression check on the `handler.ts` edit: it asserts
  exactly one line for a `POST /reports` and would fail on the `queue`/`jobQueue`
  slip described above.

## Risks

- **Low.** Additive on a path that previously did nothing at all. The one behavioural
  tightening is `enqueue` rejecting an empty request id; the only production caller
  (handler.ts:24) passes an id that is a header value or a fresh UUID.
- Out of scope, not changed here: `handler.ts:31` treats an empty `x-request-id` header
  as present (`"" ?? randomUUID()` yields `""`), which would make `Router.dispatch`
  throw before a job is ever enqueued. That is a pre-existing HTTP-layer bug, unrelated
  to job traceability, filed as **ISS-001**. It also confirms the new `enqueue`
  validation breaks no live caller: dispatch throws before the route body runs, so the
  only production `enqueue` call (handler.ts:24) can never reach it with an empty id.
