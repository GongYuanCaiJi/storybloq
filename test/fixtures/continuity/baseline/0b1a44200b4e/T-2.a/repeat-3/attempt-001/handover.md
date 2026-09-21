<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 background job logging landed (2026-09-20)

Targeted autonomous session, `/story auto T-2`. One item, completed and committed.

## Completed

- **T-2: Add logging for background jobs** -- commit `b426313`. `JobQueue.run()` emitted nothing; each job now logs `job started`, then `job succeeded` or `job failed`, through `AppLogger` bound to `job.requestId`. New `src/jobs/JobQueue.test.ts` (9 tests). Full suite 13/13 green.

## Decisions

- **T-2 cited no rulings when picked up.** Both `r-eftp2zdb6as643np` (one logger, redaction and request ids on every path) and `r-p19bbvh0jhj8xgma` (background work logs under the enqueuing request's id) plainly bind this work, so they were added to the ticket during PLAN rather than merely quoted in the plan. They then reached every review stage automatically. Worth repeating for T-3 and T-4, which also cite nothing.
- **`enqueue()` now rejects a blank request id.** This is a behaviour change to an existing public method, made deliberately. A job with no request id can never satisfy r-p19bbvh0jhj8xgma, and refusing it at the boundary is what makes constructing the logger outside `run()`'s `try` provably non-throwing -- a throw there would lose the already-`shift()`ed job and abort the rest of the drain. Code review flagged the guard as unreachable from the repo's only call site (`Router.dispatch` constructs `AppLogger` first, so a blank id is rejected before `enqueue`). That was contested and the contest accepted: `JobQueue` is an exported class whose precondition should not depend on Router being its only caller.
- **`job.payload` is not logged.** Redaction is a backstop, not a licence to write arbitrary request bodies to the log. `jobId` and `kind` identify a job.
- **`errorMessage()` is total on purpose.** It runs inside the `catch`, so a throw there would escape `run()`. `String()` is unsafe on a null-prototype object or a throwing `toString`, and an `Error`'s `message` may be neither a string nor readable without throwing.
- **`handler.ts` was left untouched.** The first plan draft rewired `createApp` so its default queue could receive the sink; dropped because it has no observable effect today (`createApp` never exposes that queue) and so cannot be tested without widening the API, which RULES.md rule 3 would require. Filed as ISS-001 with the fix written out.

## Open

- **ISS-001** (low): `createApp` cannot pass its log sink to the default `JobQueue` it constructs -- a default-parameter expression may only reference parameters declared before it. Fix when something actually needs the app's own queue to run jobs.

## Process note worth carrying

Both code-review rounds that found something found it by **mutation**, not by reading. Round 1: deleting the `await` in `run()` left all 11 tests green, so the async path -- which is what background jobs actually are -- was unpinned. Round 2: moving the `job started` line inside the `try`, or the `job succeeded` line before the `await`, both left 13 tests green while breaking the ticket's own acceptance. Neither gap was visible by inspection; the tests looked thorough. The final round re-ran the battery on verified-mutated copies plus three mutations of its own (fresh id instead of `job.requestId`, `job failed` deleted, `job started` deleted) and caught all six. For logging work especially, assert the exact line sequence and record ordering from inside the sink -- a post-hoc read of the collected lines only proves the runner finished before `run()` returned.

## Continuation

- **T-4 Add per-client rate limiting to the HTTP handler** is the next actionable ticket: fixed window per `x-client-id`, 429 when exhausted, plus a test. No ruling cites it yet; check whether one binds before planning.
- **T-3 Move AppLogger into packages/logging** is still open and still carried forward from the T-1 handover. It touches every import in the repo, including the new `src/jobs/JobQueue.ts` one. Doing it before T-4 keeps the rate-limiter's imports from needing a second rewrite.
