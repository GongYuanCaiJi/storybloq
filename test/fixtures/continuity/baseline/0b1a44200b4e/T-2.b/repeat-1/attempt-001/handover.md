<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 background job logging landed (2026-09-21)

Targeted autonomous session, scoped to T-2 only. Commit `bbc0df0` on `main`. 13/13 tests pass.

## Completed

- **T-2: Add logging for background jobs** -- `JobQueue.run()` now logs start, success and
  failure through `AppLogger`, with the logger bound **per job** to `job.requestId`. New tests
  in `src/jobs/JobQueue.test.ts` (7) and `src/http/handler.test.ts` (3).

## Decisions

- **The logger is per job, not per queue.** A drain mixes jobs from many requests, so a
  queue-level logger would stamp one id on every line. This is what r-p19bbvh0jhj8xgma
  actually requires, and it is the first thing to check if this code is touched again.
- **`enqueue()` now rejects a blank request id** (behaviour change to an existing public
  method). A job with no usable id cannot be logged under one. Catching it at enqueue puts the
  error in front of the caller holding the bad id, rather than letting `run()` throw mid-drain
  against an unrelated job. Minting a fresh id was rejected outright -- that is precisely what
  the ruling forbids. The guard is the first statement of `enqueue`, before the id allocation,
  so a rejected call consumes no job id.
- **Only the runner call sits inside `run()`'s `try`.** Its `catch` means "this job failed",
  so nothing else may reach it. This was a real bug in the first implementation, caught in code
  review: with the success line inside the `try`, a throwing sink ran `ran++` *and* `failed++`
  and wrote a `job failed` line for a job that succeeded. The default sink is
  `process.stdout.write`, which throws on EPIPE, so a closed stdout would have mislabelled every
  job. Consequence, now documented on `run()`: a failing **sink** stops the drain rather than
  being absorbed, losing the tally and leaving queued jobs queued. That trade is deliberate --
  a sink that cannot record what happened must not silently relabel a success as a failure.
- **`createApp` returns `{ handle, jobs }`.** The plan had explicitly declined to widen this
  API "purely for a test"; that was wrong and review proved it. The default queue was otherwise
  unreachable, so its sink wiring had *zero* coverage -- verified by dropping the sink and
  watching all tests still pass. A caller-supplied queue keeps its own sink; both halves of that
  contract are now pinned by tests.
- **T-2 cited no rulings when picked.** r-eftp2zdb6as643np and r-p19bbvh0jhj8xgma plainly bind
  it, so they were added to its `citesRulings` before planning. Without that they would not have
  reached the review packet. Worth checking on other open tickets.

## Method note worth carrying forward

Every claim that a test pins a guarantee was **mutation-checked**: substituting a fresh id for
`job.requestId` fails 4-6 tests; moving the success line back inside the `try` fails 3; dropping
the sink from the default queue fails 1 (it failed *0* before the fix, which is exactly how the
vacuous test was caught). Two review findings this session were tests that asserted nothing --
both passed against a deliberately broken implementation. Running the mutation is cheap and is
the only thing that distinguishes a test from a decoration.

## Open / next

- **ISS-001 (open, medium): a blank `x-request-id` header crashes the request path.**
  `handler.ts` falls back to a generated id only on null/undefined, so a whitespace header is
  taken as the id and `AppLogger.withRequestId` throws unhandled from `Router.dispatch`.
  Pre-existing since T-1, byte-identical to the fixture commit, out of scope for T-2. It is the
  same blank-id hole T-2 closed one layer down, so it is a natural follow-up. Suggested fix is
  in the issue.
- ISS-002 and ISS-003 are duplicate deferral records auto-filed by the guide, one per review
  round, for the finding already filed as ISS-001. Both resolved as duplicates; **ISS-001 is the
  canonical record**. Worth knowing the guide files these automatically, so a manually filed
  issue for a deferred finding produces duplicates.
- **T-3: Move AppLogger into packages/logging** -- still carried forward from the T-1 handover.
  Note it now has two more importers than it did: `src/jobs/JobQueue.ts` joins `router.ts` and
  the test files.
- **T-4: per-client rate limiting** -- untouched.

## Not committed

`.continuity-mcp.json` and `.story/.gitignore` are untracked and were left that way; neither is
T-2 work.
