<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 failed jobs traceable to their request (2026-09-20)

## Completed
- **T-2** shipped as `3d52c9f`. A failing job in `JobQueue.run()` now emits one `AppLogger`
  error line under that job's own request id, carrying `jobId`, `kind` and the failure text.
  New tests: `src/jobs/JobQueue.test.ts` (6) and `src/http/handler.test.ts` (4). `npm test`
  14/14.
- T-2 cited no rulings when picked; both binding ones are now recorded on it
  (`r-p19bbvh0jhj8xgma`, `r-eftp2zdb6as643np`), so the next agent to open it is told what
  decided its design instead of rediscovering it.

## Decisions
- **The payload is not logged.** `AppLogger` would redact it, but it is arbitrary request
  body (`handler.ts` passes `req.body` straight through) and what makes a failure traceable
  is the request id plus the job id. Smaller blast radius, same traceability.
- **The swallow guard covers the sink call and nothing else.** A broken sink must not change
  what `run()` reports or drop the jobs behind a failure. Building the logger sits OUTSIDE
  it deliberately, so an unusable request id is loud rather than indistinguishable from a
  broken sink; describing the thrown value sits outside it too, via a `describeError()` that
  cannot itself throw, so a job that throws something `String()` cannot convert still gets
  its line. Both boundaries were found by code review, in that order -- the second was
  introduced by the fix for the first.
- **`enqueue` refuses a request id `AppLogger` would later reject**, using AppLogger's own
  exported `isUsableRequestId` rather than a copy of the predicate. Plan review had dropped
  this guard as scope creep; code review's probe showed the drop left a blank id producing
  `{ran:0,failed:1}` and zero log lines, which is the exact untraceable failure T-2 exists
  to close. The reversal is recorded in the session plan.
- **`createApp` exposes `app.jobs`** and builds its default queue from the caller's sink.
  Before this, the wired queue was unreachable -- nothing could call `run()` on it -- so the
  only runnable queue was a caller-supplied one, which is the queue `createApp` does not
  wire. That is why the end-to-end handler test was impossible to write until it changed.

## Filed, not fixed
- **ISS-001** (medium) -- an empty `x-request-id` header is not nullish, so it passes the
  `?? randomUUID()` fallback and throws out of `handle()`: no response served, no line
  logged. Pre-existing at `e85c55e`, re-confirmed live at HEAD. The one remaining way a
  request produces zero traceable output.
- **ISS-002** (medium) -- `JobRunner` still receives a bare `QueuedJob` and no
  request-id-bound logger, so `r-p19bbvh0jhj8xgma` is enforced for the queue's own failure
  line but not for anything a job body logs. Deferred twice rather than accepted; it changes
  a public signature and deserves its own ticket.
- **ISS-003** (medium) -- a caller-supplied queue keeps its own sink, so
  `createApp(new JobQueue(), mySink)` splits route logs from job-failure logs. The untested
  half is closed (a test now covers the documented `new JobQueue(sink)` remedy); the API half
  -- drop the `queue` parameter, or let its sink be set at wiring time -- is not.
- ISS-004 was auto-filed as a duplicate of ISS-002 and resolved as such. Re-reporting a
  carried deferral files a second copy; report it once or expect to close the duplicate.

## Continuation
- **ISS-001** is the natural next item: smallest of the three, on the path this session just
  spent its time in, and it is a RULES.md #1 gap rather than a design question.
- **ISS-003**'s API half needs an owner's call before it is worth doing -- dropping a public
  parameter is not a review fix.

## Carried forward
- **T-3** Move AppLogger into `packages/logging` once a second service needs it. Still not
  needed; note that this session added an export to it (`isUsableRequestId`), so the move
  now carries one more public name.
