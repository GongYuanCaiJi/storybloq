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

RULES.md adds: Node built-ins only -- satisfied, because the imports this change adds are
internal module imports and pull in no package dependency (the earlier wording, "no new
imports", was simply wrong: change 1 does add imports). And a behaviour change comes with a
test named `<Module>.test.ts` beside the module. Two modules change here, so two test files
are in scope: `src/jobs/JobQueue.test.ts` and `src/http/handler.test.ts`, neither of which
exists yet. `handler.ts`'s only current coverage sits in `src/http/router.test.ts`, which
is a pre-existing deviation from rule 3; this ticket changes `handler.ts`, so it is the
moment to close it rather than inherit it.

`tsconfig.json` sets `verbatimModuleSyntax`, so type-only imports need the inline `type`
modifier: `import { AppLogger, type Sink } from "../platform/logging/AppLogger.ts"`, the
form `src/http/router.ts:6` already uses.

## Changes

### 1. `src/jobs/JobQueue.ts`

- Import `AppLogger` and `type Sink` from `../platform/logging/AppLogger.ts`.
- Add an optional sink to the constructor, mirroring `Router`'s existing shape
  (`constructor(sink?: Sink)`, stored in a `#sink` private field) so a test can observe
  what jobs log and production keeps `AppLogger`'s default sink. This is the pattern the
  codebase already uses in `src/http/router.ts`; no new mechanism is introduced.
- **Validate the request id at `enqueue()`, not at `run()`.** `enqueue` currently accepts
  any `opts.requestId`, including `""`. `AppLogger.withRequestId` throws on a blank id
  (`AppLogger.ts:61`, pinned by `AppLogger.test.ts:43`), so once `run()` builds a logger per
  job, a single job queued under a blank id would throw *mid-drain* -- aborting the loop,
  discarding every job still queued, and losing the `{ ran, failed }` return. `run()` cannot
  throw today, and this change must not make it throw.

  So `enqueue` gets the same guard as the logger: `if (opts.requestId.trim() === "") throw
  new Error("JobQueue requires a non-empty request id")`, placed as the **first statement of
  `enqueue`, before the `#next` increment** at `JobQueue.ts:23`. Placement matters: the id is
  allocated on line 23 and the push happens on line 24, so a guard sitting between them would
  leave `size` correct but silently burn a job id -- the next successful enqueue would be
  `job-3` rather than `job-2`. That is an observable side effect of a rejected call, so the
  guard goes first and test 4 pins it. The failure then surfaces at the
  enqueue call, synchronously, against the caller that actually has the bad id -- instead of
  at drain time against an unrelated job. Falling back to a fresh id is explicitly **not** an
  option: r-p19bbvh0jhj8xgma forbids a job logging under anything but its enqueuing request
  id, and inventing one to keep the drain alive would break the exact guarantee this ticket
  exists to provide. This is a behaviour change to `enqueue` and is covered by test 4 below.

- In `run()`, per job, build `AppLogger.withRequestId(job.requestId, this.#sink)` **before
  the `try`**, not inside it -- and so does the `job started` line. Two reasons, both
  load-bearing: `log` must be in scope in
  `catch (err)` to emit the failure line at all, and logger construction must not be caught
  by a `catch` whose job is to absorb *runner* failures -- a throw from the logger would
  otherwise be silently miscounted as a failed job. With the `enqueue` guard above, the
  constructor cannot throw here in practice; the placement is what keeps that true rather
  than incidental. Emit:
  - `log.info("job started", { jobId: job.id, kind: job.kind })` -- outside the `try`,
    immediately before it, for the same reason as the logger itself: a faulty sink throwing
    here must not be absorbed by a `catch` that would record it as a *runner* failure.
  - on success, **outside and after the `try`** -- `ran++` then
    `log.info("job succeeded", { jobId: job.id, kind: job.kind })`, with the `catch` ending
    in `continue` so the success path is not reached after a failure.

    *(Revised during code review, round 1. The original plan put this line inside the `try`,
    which was wrong for the same reason the start line is outside it: if the sink throws
    while writing `job succeeded`, `ran++` has already run and the `catch` then also runs
    `failed++` and writes a `job failed` line for a job that actually succeeded --
    `{ ran: 1, failed: 1 }` for one job. The default sink is `process.stdout.write`, which
    throws on EPIPE, so a closed stdout would mislabel every job. Only the runner call
    belongs inside a `try` whose `catch` means "this job failed".)*
  - in `catch (err)` -- `log.error("job failed", { jobId: job.id, kind: job.kind, error: message(err) })`
    where `message(err)` is a tiny local helper: `err instanceof Error ? err.message : String(err)`,
    wrapped so that a value whose `String()` itself throws (a null-prototype object) yields
    `"unknown error"` rather than taking down the drain -- the same principle as the guard
    above, applied to the one other expression in the loop that can throw.
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
`const jobs = queue ?? new JobQueue(sink)`.

**Rename the use site too.** The `POST /reports` route closure at `handler.ts:24` calls
`queue.enqueue(...)` and must become `jobs.enqueue(...)`. Missing this is not a cosmetic
slip: with `queue` now optional, `queue.enqueue` is a strict-mode type error
("'queue' is possibly 'undefined'"), and if it somehow compiled it would use the un-sinked
path -- defeating the entire change. Nothing in this repo's verification would catch it:
there is no `node_modules`, so no `tsc` runs, and `node --test` strips types without
checking them. The test that actually catches it is §4's **default-queue** case, not the
explicit-queue one: when the caller supplies a queue, `queue` and `jobs` are the same
object and a missed rename behaves identically, so that test passes green either way. With
`createApp(undefined, sink)`, `queue` is `undefined` and the missed rename throws a
TypeError on the first POST. That is a crash rather than a readable assertion, so the case
asserts on the route line explicitly and this is called out here to stop a later reader
trusting the wrong test.

**Contract when both arguments are passed.** `createApp(myQueue, sink)` leaves `myQueue`
with whatever sink it was built with, so route lines go to `sink` while job lines go
wherever `myQueue` sends them. That is the deliberate contract -- a caller who constructs a
queue owns its sink, and `createApp` silently rebinding it would be worse -- but it is
surprising enough to state rather than leave implicit. Record it as a one-line doc comment
on `createApp` (`src/http/handler.ts:17`): the `sink` parameter applies to the router and to
the default queue; a caller-supplied queue keeps its own.

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
4. **A blank request id is refused at enqueue, and the drain stays intact.** Assert
   `queue.enqueue(job, { requestId: "  " })` throws `<ABS>`, that the queue
   `size` is unchanged by the rejected call, that the **next successful enqueue still
   returns the id the rejected call would have taken** (no burned id -- this is what pins
   the guard to the first line of `enqueue`, since `size` alone cannot distinguish the two
   placements), and that a subsequent `run()` over the well-formed jobs still returns its
   full `{ ran, failed }`. This pins the finding that motivated the guard: the failure
   belongs at the enqueue call site, not mid-drain.

### 4. `src/http/handler.test.ts` (new)

The three `JobQueue` tests above construct jobs by calling `enqueue` directly, so none of
them pins the chain r-p19bbvh0jhj8xgma is actually about: the id assigned in `handle()`
reaching the job's log lines. A regression in `handler.ts` -- enqueuing under a fresh
`randomUUID()`, or the sink threading being dropped -- would pass every one of them.

This file also closes the rule-3 gap noted above, since `handler.ts` has had no
`handler.test.ts` of its own.

One end-to-end test: construct a `JobQueue` with the test sink, pass it to `createApp`
along with the same sink, `POST /reports` with `x-request-id: "req-http-1"`, then `run()`
the queue with a succeeding runner. Assert the `job started` and `job succeeded` lines both
carry `requestId: "req-http-1"` -- the id the HTTP layer assigned, not a fresh one -- and
that they arrived at the supplied sink at all.

A second case covers the default-queue path: call `createApp(undefined, sink)`, POST a
report, **drain the queue**, and assert the job lines carry the HTTP-assigned id.

*(Revised during code review, round 1. The original plan asserted only on the route line
here and declined to widen `createApp`'s API "purely for a test". That was the wrong
tradeoff, and the review demonstrated it: the route line comes from the `Router`, which was
already wired to the sink before this change, so the test passed identically with the sink
dropped from the default queue -- verified by reverting `new JobQueue(sink)` to
`new JobQueue()` and watching all ten tests still pass. The diff's one `handler.ts`
behaviour change therefore had no coverage at all, against RULES.md rule 3. `createApp` now
returns `{ handle, jobs }` so the default queue can be drained. The widening is one field,
it is useful beyond the test -- a caller with no handle on the queue cannot run it -- and
the alternative was an assertion that could not fail.)*

## Verification

- `npm test` -- the two existing test files plus the two new ones, all passing.
- `npx --no-install tsc --noEmit` if a local TypeScript is available; skip rather than
  install, since RULES.md keeps the project dependency-free. Assume it will **not** run:
  there is no `node_modules` here, and `node --test` strips types without checking them.
  No type error in this change is caught by tooling, so the `queue` -> `jobs` rename at
  `handler.ts:24` has to be verified by reading the file after editing it, and the tests
  are the real safety net.

## Out of scope

- T-3 (moving `AppLogger` into `packages/logging`) -- imports here will move with it.
- Any change to `AppLogger` itself. The redaction and request-id machinery already does
  what this ticket needs; touching it would put T-1's guarantees back in review for no gain.
