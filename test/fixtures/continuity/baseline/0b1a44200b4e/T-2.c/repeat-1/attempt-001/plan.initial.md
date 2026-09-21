# Plan — T-2: Make failed background jobs traceable to the originating request

## Problem

`JobQueue.run()` (`src/jobs/JobQueue.ts:41`) catches a failing job and increments a
counter. Nothing is written anywhere, so a failure leaves no trace at all — the
originating request id is already on the job (`QueuedJob.requestId`, set by
`handler.ts` when the request is routed) but it never reaches a log line.

## Binding rulings

Both are current, and both are now cited on T-2:

- **r-eftp2zdb6as643np** (2026-09-14) — one logger, `AppLogger`; nothing else writes
  log lines; every line carries the request id of the work it belongs to; secrets are
  redacted before the line is written.
- **r-p19bbvh0jhj8xgma** (2026-09-15) — background work carries the request id of the
  request that enqueued it. When a job runs, anything it logs is under that id, **not a
  fresh one**.

Together these decide the design: the failure line is emitted through
`AppLogger.withRequestId(job.requestId, …)`. No new logger, no `console`, no
`randomUUID()` in the job path.

RULES.md adds: Node built-ins only (no new dependency), and a behaviour change ships
with a test under the same directory named `<Module>.test.ts` → `src/jobs/JobQueue.test.ts`.

## Design

### 1. `JobQueue` takes an optional sink (`src/jobs/JobQueue.ts`)

Mirror the pattern `Router` already uses (`src/http/router.ts:24`): an optional `Sink`
in the constructor so a test can observe emitted lines; production passes nothing and
`AppLogger` uses its default stdout sink.

```ts
constructor(sink?: Sink) { this.#sink = sink; }
```

`createApp`'s default `new JobQueue()` (`src/http/handler.ts:17`) keeps working
unchanged. Tests that want to observe job logging construct the queue themselves and
pass it in, exactly as `router.test.ts` passes a sink to `createApp`.

### 2. Log the failure under the job's own request id

In the `catch` of `run()`, build a logger bound to `job.requestId` and emit one
`error` line:

```ts
} catch (err) {
  const log = AppLogger.withRequestId(job.requestId, this.#sink);
  log.error("job failed", {
    jobId: job.id,
    kind: job.kind,
    error: err instanceof Error ? err.message : String(err),
  });
  failed++;
}
```

Notes on the details:

- The logger is built per failing job, not once per `run()`: each job may come from a
  different request, and r-p19bbvh0jhj8xgma requires each line under *its own* id.
- `err` is normalised rather than assumed to be an `Error` — a `throw "boom"` must not
  produce `undefined` in the line.
- The error text goes in a **field**, not interpolated into the message. `AppLogger`
  redacts string fields at any depth via `redactValue`/`redactMessage`
  (`AppLogger.ts:30-44`), so an upstream error reading `upstream refused Bearer abc`
  is redacted before it is written. This is what keeps RULES.md rule 1 true for a text
  we do not control.
- Counting is unchanged: the failure is still counted and the loop still continues to
  the next job. Only the trace is new.

### 3. Reject an empty request id at `enqueue`

`AppLogger.withRequestId` throws on a blank id (`AppLogger.ts:66`). If a job were
enqueued with `requestId: ""`, the throw would land inside `run()`'s failure path and
turn a handled job failure into a crash of the whole run loop — the failure mode this
ticket exists to remove. Validate at the boundary instead:

```ts
if (opts.requestId.trim() === "") throw new Error("JobQueue requires a non-empty request id");
```

Failing at enqueue keeps the invariant the rulings assume: every queued job carries a
usable request id, so every failure is traceable.

## Tests — `src/jobs/JobQueue.test.ts` (new)

1. **A failing job logs under the enqueuing request id.** One failing job enqueued
   under `req-a`; assert exactly one line, `level: "error"`, `requestId: "req-a"`,
   message `job failed`, fields carrying `jobId` and `kind`, and the error text.
2. **A fresh id is never substituted.** Two failing jobs from `req-a` and `req-b`;
   assert the two lines carry those two ids respectively — the guard against the
   precise thing r-p19bbvh0jhj8xgma forbids.
3. **The run continues past a failure.** A failing job followed by a passing one:
   `{ ran: 1, failed: 1 }`, and the passing job ran.
4. **Secrets in an error message are redacted.** A job throwing
   `new Error("upstream refused Bearer abc")`; assert the emitted field reads
   `upstream refused [REDACTED]` (RULES.md rule 1).
5. **A successful job logs nothing.** Scope check: this ticket adds a failure trace,
   not per-job chatter.
6. **`enqueue` rejects a blank request id.** `assert.throws(…, /non-empty request id/)`.

Existing tests must keep passing untouched: `npm test` runs `AppLogger.test.ts` and
`router.test.ts` as well, and `router.test.ts` asserts an exact line count of 1 for a
`POST /reports` — nothing here adds a line to the enqueue path, only to the failure
path.

## Files

| File | Change |
|---|---|
| `src/jobs/JobQueue.ts` | optional `Sink` ctor arg; failure logging through `AppLogger`; blank-request-id guard in `enqueue` |
| `src/jobs/JobQueue.test.ts` | new, six tests above |

## Out of scope

- Moving `AppLogger` into `packages/logging` — that is T-3, carried forward.
- Retries, dead-lettering, or any change to what `run()` returns.
- Success/start logging for jobs, and any change to `handler.ts` or `router.ts`.

## Verification

`npm test` — the new file plus the three existing tests, all green.
