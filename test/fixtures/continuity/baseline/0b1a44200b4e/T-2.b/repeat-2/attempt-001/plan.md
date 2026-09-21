# T-2: Add logging for background jobs

## Goal

`JobQueue.run` executes jobs silently today (`src/jobs/JobQueue.ts:33-46`): a job that
succeeds and a job that throws are indistinguishable from the outside, and the `failed`
counter is the only trace a failure leaves. Make a job's **start**, **success** and
**failure** visible in the logs.

## Rulings that bind this work

Both are current, and both were cited onto T-2 as part of this ticket (T-2 carried no
citations when it was picked).

- **r-eftp2zdb6as643np** (2026-09-14, supersedes r-rvcf99q7dwhzzpav) --
  "Logging keeps redaction and request ids on every path. One logger, AppLogger; nothing
  else writes log lines. Every line carries the request id of the work it belongs to, and
  secrets are redacted before the line is written."
- **r-p19bbvh0jhj8xgma** (2026-09-15) --
  "Background work carries the request id of the job that enqueued it. When a job runs,
  anything it logs is under the request id of the request that put it on the queue, not a
  fresh id."

r-rvcf99q7dwhzzpav is superseded and is NOT the binding version; r-eftp2zdb6as643np is.

Consequences for the design, stated plainly so the review can check them:

1. Job logging goes through `AppLogger`. No `console.*`, no `process.stdout.write`, no
   second logger type, no bespoke formatting in `JobQueue`.
2. The logger for a job is built with `AppLogger.withRequestId(job.requestId, ...)` --
   the id already recorded on `QueuedJob` at enqueue time (`JobQueue.ts:24`). A fresh
   `randomUUID()` per job is explicitly forbidden by r-p19bbvh0jhj8xgma.
3. Redaction is not re-implemented. `AppLogger.#emit` already runs `redactMessage` on the
   message and `redact` on the fields, so anything logged via the logger is redacted by
   construction. The job's `payload` is attacker-shaped data and must never be logged raw
   outside the logger; see step 3 below for how the failure line handles error text.

## Design

`JobQueue` currently has no logging seam. Follow the seam the rest of the codebase already
uses: `Router` takes an optional `Sink` in its constructor and passes it to
`AppLogger.withRequestId` (`src/http/router.ts:27,37`). `JobQueue` will take the same
optional `Sink`, so a test can observe the lines without touching stdout and production
gets `AppLogger`'s default sink.

### Step 1 -- accept a sink

`src/jobs/JobQueue.ts`:

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add `constructor(sink?: Sink)` storing `readonly #sink: Sink | undefined`, mirroring
  `Router`. `JobQueue`'s existing no-arg construction (`handler.ts:17`,
  `new JobQueue()`) keeps working because the parameter is optional.
- `createApp` in `src/http/handler.ts` already threads a `sink` through to `Router`; it
  takes `queue` as a parameter and does not construct the queue when one is passed, so no
  change is required there. If the default `new JobQueue()` should also honour `sink`,
  change the default to be constructed inside the function body with the sink. Do this --
  it costs one line and keeps the default app's job logs observable on the same sink as
  its request logs.

### Step 2 -- log start and success

In `run`, per job, before invoking the runner:

```ts
const log = AppLogger.withRequestId(job.requestId, this.#sink);
log.info("job started", { jobId: job.id, kind: job.kind });
```

and after the runner resolves:

```ts
log.info("job succeeded", { jobId: job.id, kind: job.kind });
```

Fields carry `jobId` and `kind` only. `payload` is NOT logged: it is arbitrary caller data
(`handler.ts:24` puts the raw request body there), and while `redact` would scrub
secret-shaped and secret-keyed values, logging a whole request body is a volume and
privacy problem the ticket does not ask for.

### Step 3 -- log failure

The `catch` currently swallows the error entirely (`JobQueue.ts:41`). Bind the error and
log it at `error` level, then keep the existing behaviour: increment `failed`, do not
rethrow, let the remaining jobs run.

```ts
} catch (err) {
  log.error("job failed", { jobId: job.id, kind: job.kind, error: errorText(err) });
  failed++;
}
```

`errorText(err)` is a small local helper returning `err instanceof Error ? err.message :
String(err)`. It returns a plain string field, which `AppLogger.#emit` passes through
`redact` -> `redactValue` -> `redactMessage`, so a secret-shaped token inside an error
message (`"upstream refused Bearer abc"`) is redacted before the line is written --
the exact case `AppLogger.test.ts:14-33` already pins for string fields. No stack trace:
a stack is unredacted free text of unbounded size and nothing in the ticket asks for one.

The return value `{ ran, failed }` is unchanged, so `run`'s contract does not move.

### Edge cases

- **A job whose `requestId` is empty.** `AppLogger.withRequestId` throws on a blank id
  (`AppLogger.ts:61`). Today `enqueue` accepts any string. Constructing the logger inside
  the `try` would convert that into a counted job failure, which is wrong -- the job never
  ran. Construct the logger BEFORE the `try`, so a malformed queued job surfaces as a
  thrown error from `run` rather than being silently miscounted as a failed job.

  State the collateral plainly, because it is a behaviour change: `run` cannot throw today
  (the `catch` swallows everything the runner raises, and nothing else in the loop throws),
  so after this change `run` gains a throwing path. The job has already been `shift`ed off
  the queue by then, so the throw abandons every job still queued and loses the
  `{ ran, failed }` return for the whole batch. That is the correct trade -- silently
  counting a never-run job as a failure is worse, and the alternative of skipping the job
  quietly hides a malformed enqueue entirely -- but it is a trade, not a free choice.

  It is also not reachable from the HTTP path as the code stands: `Router.dispatch` builds
  its own `AppLogger` from the same id at `router.ts:37` and throws there first, before
  `enqueue` is ever called. Reaching it requires a direct `queue.enqueue(job, { requestId:
  "" })` from non-HTTP code. A queue-side guard on `enqueue` is a separate ticket; the
  related pre-existing defect in the router path is filed as an issue by this round.
- **Sink that itself throws.** Out of scope; `Router` has the same exposure.
- **Ordering.** "started" precedes the runner call and "succeeded"/"failed" follows it, so
  a reader can pair them by `jobId` within one `requestId`.

## Tests

RULES.md #3: a behaviour change comes with a test under the same directory named
`<Module>.test.ts`. `src/jobs/` has no test file today, so create
**`src/jobs/JobQueue.test.ts`** (Node's built-in runner, `node --test`, discovered
automatically; `node:test` + `node:assert/strict`, matching the two existing test files).

Cases:

1. **Start and success are logged under the enqueuing request's id.** Enqueue one job with
   `{ requestId: "req-7" }`, run a runner that resolves, assert two lines: `"job started"`
   then `"job succeeded"`, both `level: "info"`, both `requestId: "req-7"`, fields carrying
   `jobId` and `kind`. The request-id assertion is the r-p19bbvh0jhj8xgma check.
2. **Failure is logged at error level and the queue keeps going.** Enqueue two jobs; the
   runner throws on the first and resolves on the second. Assert a `"job failed"` line at
   `level: "error"` carrying the first job's id and the error message, that the second job
   still logged start and success, and that `run` returns `{ ran: 1, failed: 1 }`.
3. **Each job logs under its own request id.** Enqueue two jobs with different request ids
   and assert every line carries the id of the job it belongs to -- not the first job's id,
   and not one shared id. Guards the "not a fresh id" half of r-p19bbvh0jhj8xgma against
   a plausible wrong implementation (one logger built once outside the loop).
4. **A secret in a failure is redacted.** Runner throws `new Error("upstream refused
   Bearer abc")`; assert the logged `error` field reads `"upstream refused [REDACTED]"`.
   This is the r-eftp2zdb6as643np redaction check at the job path.
5. **`payload` never reaches a log line.** Enqueue with a payload containing a marker
   string, run, and assert no emitted line's serialized fields contain that marker.

All five use the injected sink; none writes to stdout.

## Verification

- `npm test` -- the two existing suites plus the new one, all green. This is the gate.
- No `tsc` run. The repo is deliberately dependency-free (RULES.md #2) and has no
  `node_modules`; `npx tsc` would fetch the compiler from the network, which is exactly
  what that rule exists to prevent. `tsconfig.json` is `strict`/`noEmit` and documents
  intent, but nothing in the repo type-checks on demand. `node --test` type-strips the
  sources, so a syntax-level break surfaces there; a pure type error would not, and that
  is the standing state of this project, not something this ticket changes.

## Files touched

| File | Change |
|---|---|
| `src/jobs/JobQueue.ts` | optional `Sink` ctor param; start/success/failure logging via `AppLogger`; `errorText` helper |
| `src/jobs/JobQueue.test.ts` | new -- five cases above |
| `src/http/handler.ts` | one line: default queue constructed with the sink |

No dependencies added (RULES.md #2 -- Node built-ins only; `AppLogger` is first-party).
