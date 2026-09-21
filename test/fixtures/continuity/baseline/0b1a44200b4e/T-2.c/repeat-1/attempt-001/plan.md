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

Tests that want to observe job logging construct the queue themselves and pass it in,
exactly as `router.test.ts` passes a sink to `createApp`.

`createApp` must pass its own sink down to the queue it creates by default, or the
trace this ticket adds escapes the one sink the app was configured with: `createApp`
already takes a `sink` for the router, and a caller supplying it reasonably expects
*every* line the app produces to arrive there, not just the router's. The existing
signature cannot express that — `queue: JobQueue = new JobQueue()` is declared before
`sink`, so the default cannot reference it. Make the parameter optional and resolve it
in the body:

```ts
export function createApp(queue?: JobQueue, sink?: Sink) {
  const jobs = queue ?? new JobQueue(sink);
  …
}
```

Call sites are unaffected: `createApp()`, `createApp(undefined, sink)` and
`createApp(myQueue)` all keep their current meaning, and an explicitly supplied queue
keeps whatever sink it was built with. This is a two-line change to `handler.ts`, in
scope because without it the failure line is unobservable through the assembled app.

**Amendment, found while writing the test for this (round 1 of IMPLEMENT).** The
paragraph above is necessary but not sufficient: `createApp` returns only `{ handle }`,
so the queue it builds by default is unreachable — nothing can call `run()` on it, and
the sink it inherited can never emit anything. The wiring was untestable because it was
unusable. `createApp` therefore also returns the queue it is using:

```ts
return { handle, jobs };
```

This is what makes "a request's failed job is traceable back to that request"
demonstrable end-to-end rather than only at the `JobQueue` unit boundary.

**Second amendment, from code review round 1.** Once `App.jobs` exists, the `queue`
parameter is not just unnecessary but harmful: a caller-supplied queue keeps its own
sink, so `createApp(new JobQueue(), mySink)` sends job-failure lines to stdout while
every other line from that app goes to `mySink` — an observability split in exactly
the lines this ticket adds, and the shape a caller would naturally reach for under the
old signature. The parameter is therefore removed: `createApp(sink?: Sink)` owns its
queue, and callers read it back from `App.jobs`. One existing call site
(`router.test.ts`, `createApp(undefined, sink)`) is updated to the new signature.

### 2. Log the failure under the job's own request id

In the `catch` of `run()`, build a logger bound to `job.requestId` and emit one
`error` line:

```ts
} catch (err) {
  const log = AppLogger.withRequestId(job.requestId, this.#sink);
  log.error("job failed", {
    jobId: job.id,
    kind: job.kind,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
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

**Third amendment, from code review round 1.** Two ways the logging itself could break
the drain guarantee the bare `catch {}` used to give for free:

- a sink that throws (real I/O: a closed pipe, a full disk) would propagate out of
  `run()`, losing both the failure line and every job after it. The logging therefore
  moves into a `#logFailure` helper wrapped in its own `try/catch`. The swallow is
  silent because r-eftp2zdb6as643np leaves no second channel to report it on.
- `String(err)` itself throws for a null-prototype object, and flattens `{ token: … }`
  to text that `redact()` can no longer see the key of.

**Fourth amendment, from code review round 2.** Round 1's answer to that second point —
hand the raw thrown value to the logger so `redact()` walks it — was wrong, and round 2
demonstrated two defects it introduced:

- **A secret leak (critical).** `redact()` copies function values through unchanged, so
  a `toJSON` method on the thrown object survives redaction and is then invoked by the
  sink's `JSON.stringify` — writing back exactly what redaction removed. Reproduced
  against the real default sink: a job throwing `{ toJSON: () => ({ token: "sk-…" }) }`
  put that token on stdout verbatim. RULES.md rule 1 and r-eftp2zdb6as643np both broken.
- **Silent loss of the line.** A circular, bigint, or throwing-getter value made
  `redact()` or the sink throw; `#logFailure`'s catch swallowed it and the failure
  produced no line at all — the exact outcome this ticket exists to prevent, now
  silent. Reproduced: a circular throw logged nothing while `run()` reported `failed: 1`.

Both are fixed by normalising the thrown value BEFORE it reaches the logger, rather
than choosing between raw value and `String()`. `describeThrown` converts it to plain,
bounded data: functions become inert markers (so nothing can run after redaction),
cycles become `[circular]`, depth past 4 becomes `[truncated]`, a getter that throws
costs its own key (`[unreadable]`), bigints and symbols become strings, and `Error`
instances at any depth keep `name: message` — which also recovers a nested `cause`,
whose message is non-enumerable and had been silently dropping to `{}`. Keys survive,
so key-based redaction still applies. `#logFailure` additionally retries once with a
constant `"[unloggable thrown value]"` if the first emit fails, so a failure reaches
the log under its request id even when its cause cannot be described.

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
| `src/http/handler.ts` | resolve the default queue in the body so it inherits `createApp`'s sink |

## Known, deliberately not fixed here

A blank `x-request-id` header is passed through by `??` and makes `handle()` throw
inside `AppLogger.withRequestId` rather than returning a response. Verified at HEAD;
filed as **ISS-001**. It is a defect in how the id is born, not in how jobs are traced,
and fixing it here would widen this ticket's diff into the request path.

## Out of scope

- Moving `AppLogger` into `packages/logging` — that is T-3, carried forward.
- Retries, dead-lettering, or any change to what `run()` returns.
- Success/start logging for jobs; any change to `router.ts`; any change to `handler.ts`
  beyond the default-queue wiring in section 1.

## Verification

`npm test` — the new file plus the three existing tests, all green.

## Fifth amendment, from code review round 3

Round 3 reviewed `describeThrown` itself — round 2's fix was new, security-relevant
code that had never been independently looked at. Three blocking defects, all in that
new code, all reproduced against the real stdout sink:

- **A secret in KEY position was written verbatim.** `redact()` tests key names but
  only ever replaces values, and `describeThrown` copies arbitrary runtime-controlled
  keys out of a thrown value. `throw { "sk-…": "cache miss" }` put the token on stdout
  while the same token in value position was redacted. Fixed in `AppLogger.redact`
  rather than in `JobQueue`: the ruling puts redaction in the logger, and any caller
  logging an outside-controlled key map had the same hole.
- **Boxed primitives and byte views fragmented secrets past redaction.**
  `Object.keys(new String("sk-…"))` explodes it into per-index characters, which no
  pattern can match; a `Buffer` became a list of byte values. Fixed by unwrapping
  wrappers through `valueOf` and summarising any `ArrayBuffer` view as a byte count.
- **Shared references amplified one failure into a huge line.** `seen` released each
  value on the way out, so a non-circular DAG was re-expanded down every path to it:
  seven small objects produced a 6.6 MB line, and a wider case 352 MB. Fixed by never
  releasing `seen` — a value is described once per line, repeats render `[seen]`.

Also fixed: a `__proto__` key silently swallowed the diagnostic (the output object is
now null-prototype), and the fallback could emit a SECOND, contradicting line when a
sink threw after writing — the description is now computed first and emitted exactly
once. `throw undefined` renders `[undefined]` rather than vanishing from the line.

Accepted limitation: cross-realm values (a `vm` context's `Error`) fail `instanceof`
and render as `{}`. Noted rather than fixed; this service creates no realms.
