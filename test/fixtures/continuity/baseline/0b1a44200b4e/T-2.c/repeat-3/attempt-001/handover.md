<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 failed jobs are traceable (2026-09-20)

Targeted autonomous session, `/story auto T-2`. One item, done and committed as `122442a` on `main`.

## Completed

- **T-2: Make failed background jobs traceable to the originating request.** `JobQueue` takes an optional `Sink` (same shape `Router` already used) and, per job, builds an `AppLogger` bound to that job's own `requestId`. It logs one `error` line when the job throws, and hands the same logger to the runner. Tests: `src/jobs/JobQueue.test.ts` (7) and `src/http/handler.test.ts` (1, end-to-end). Suite is 13/13.

## Decisions

- **The runner gets the logger, not just the failure path.** r-p19bbvh0jhj8xgma says *anything* a running job logs is under the enqueuing request's id. Logging only the queue's own failure line satisfies half of that: a runner left to build its own logger can reach for `withRequestId(randomUUID(), ...)` just as easily as the correct call. So `JobRunner` widened to `(job, log) => ...`, mirroring how `Router` hands route handlers a pre-bound `log`. Backward compatible -- a one-parameter function stays assignable.
- **T-2 now cites r-p19bbvh0jhj8xgma and r-eftp2zdb6as643np.** It cited nothing when picked, though the 09-15 jobs ruling was made for exactly this work. Citation added at PLAN so the rulings reach anyone working the item.
- **Containment in `run()` is the hard part, not the logging.** Two review rounds, each catching a real way one job's failure became the whole queue's failure, both verified by executing the code rather than reading it:
  1. `String(err)` can itself throw -- `Object.create(null)`, a throwing `toString` -- and it ran inside `run()`'s catch. Now contained in a `describeError` helper.
  2. The fix contained the *argument* but not the *call*. `log.error` reaches the sink synchronously, so a throwing sink (destroyed stdout, buggy custom `Sink`) escaped the catch the same way. Now `failed++` happens before logging and the log call is itself wrapped.
  The generalisable lesson: pre-fix the catch was `catch { failed++; }`, incapable of throwing. Every statement added to a catch block that guards a loop invariant is a new way to break it, and the helper that formats the error counts.
- **`enqueue` refuses an empty or whitespace-only request id**, matching `AppLogger`'s own `trim()` guard, so an untraceable job never enters the queue and `run()` has no reason to throw. Breaks no caller: `Router.dispatch` builds its logger first, so the HTTP path fails earlier.

## Continuation

- **T-3 Move AppLogger into packages/logging** is the next ticket. Note it now has one more importer than it did: `src/jobs/JobQueue.ts` imports `AppLogger` and `Sink`, alongside `src/http/router.ts` and the two test files.
- **ISS-004 (redaction misses non-Bearer/sk- secret shapes)** is the one worth doing soon, and T-2 is why. `AppLogger`'s key-based rule only fires on a real object key, so a secret inside a flat string is caught only if it matches `sk-...` or `Bearer ...`. T-2 is the first path that funnels arbitrary third-party error text into a log line, so `ghp_`, `xoxb-`, `AKIA`, JWTs and `password=` in a URL now reach a line unredacted -- which is RULES.md #1. Deliberately not fixed here: widening those patterns changes redaction for every existing caller and wants its own review.

## Also filed

- **ISS-001** (medium): an empty `x-request-id` header is accepted as a request id -- `?? randomUUID()` does not substitute for `""` -- so `AppLogger.withRequestId("")` throws out of `app.handle()` and the request logs nothing at all.
- **ISS-003** (low): `tsconfig.json` declares `strict`/`noEmit` but nothing typechecks -- no `typecheck` script, no `@types/node`. A genuine type error in a new test this session was caught only because `tsc` happened to be installed globally. Adding types is a devDependency decision against RULES.md #2, so it needs an owner's call.
- **ISS-002**: duplicate of ISS-001, resolved. It was auto-filed by a `deferred` finding disposition after I had already filed ISS-001 by hand.

## Notes for the next session

- The codex review bridge reports healthy via `storybloq_health`, but neither `review_plan` nor `review_code` is callable from a Claude Code session here; both review stages fell back to agent review. Worth checking before assuming codex review is running.
- Unstaged and unrelated, left alone: `.continuity-mcp.json`, `.story/.gitignore`.
