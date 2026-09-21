<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 background job logging landed (2026-09-20)

Targeted autonomous session, `/story auto T-2`. One target, completed. Commit `3821fbb` on `main`.

## Completed

- **T-2: Add logging for background jobs** — `JobQueue.run()` emits `job started` / `job succeeded` / `job failed` through AppLogger, one logger per job bound to `QueuedJob.requestId`. Six tests in `src/jobs/JobQueue.test.ts`. Suite is 10/10.
- Cited **r-eftp2zdb6as643np** and **r-p19bbvh0jhj8xgma** on T-2 (it cited neither, so neither was reaching the review stages).

## Decisions

- **`JobRunner` widened to `(job, log) => ...`.** r-p19bbvh0jhj8xgma governs *anything* a job logs, not just the three lines JobQueue emits. Under the old one-arg signature a runner's path of least resistance is minting a fresh id, which violates the ruling while every queue-level test stays green. Handing the bound logger down is the `Router`/`RouteHandler` precedent and makes it structural. Backward compatible — a `(job) => ...` runner still assigns.
- **`enqueue()` rejects a blank request id.** A job without one cannot be logged under its own id, and both escapes are forbidden (fresh id by r-p19bbvh0jhj8xgma, dropping lines by r-eftp2zdb6as643np). This is a contract check for direct non-HTTP callers — it is *not* reachable from the HTTP path, since `Router.dispatch` builds the logger first. The reachable hole is ISS-001.
- **`job.payload` is deliberately not logged.** It is caller-controlled `unknown` (literally `req.body` on the HTTP path) and `redact()` only catches secret-shaped values or secret-named keys, so a secret under a neutral key would reach the line. The tests assert a *closed* field set (`assert.deepEqual`), which is what pins this — an open key-presence check would let a later change add it back silently.
- **No `finally`, and the success log sits outside the `try`.** A `finally` would log a failed job as succeeded. Keeping `ran++` and the success log inside the `try` had the mirror bug: a throwing sink counted one job both ways (`{ran: 2, failed: 2}`) and logged a succeeded job as failed. Now only the runner is guarded; a broken sink propagates as the infrastructure error it is.
- **`src/http/handler.ts` deliberately untouched.** An earlier plan draft wired the injected sink into the default queue; dropped because `createApp` never exposes the queue and `JobQueue.run()` has zero callers, so nothing could observe it and it would be a signature change with no test in its own directory (RULES #3). Recorded as ISS-003.

## Rejected approach

Exposing the queue or a `drain()` from `createApp` to get an end-to-end HTTP→enqueue→run test. It is the stronger proof that the request id survives the whole chain, but it widens `createApp`'s public API to serve a caller that does not exist yet. Revisit when something actually drains the app-level queue — that is the moment to do it, and ISS-003 is where it is written down.

## Issues filed

- **ISS-001** (medium) — `handler.ts:31` mints the request id with `?? randomUUID()`, which does not catch `""`. A client sending an empty `x-request-id` header makes `Router.dispatch` throw and `app.handle` reject. Fix is to normalize at the boundary; does not conflict with r-p19bbvh0jhj8xgma.
- **ISS-002** (low) — no `@types/node`, so `tsc --noEmit` fails on every file using a Node built-in and the project cannot actually be typechecked despite `strict: true`. A real type error did hide in that noise this session. The obvious fix (`npm i -D @types/node`) sits against RULES #2, so whether that rule covers devDependencies is an **owner call**.
- **ISS-003** (low) — `createApp`'s default `JobQueue` ignores the injected sink, so job lines and route lines would go to different destinations for whoever first drains the queue.

## Notes for next session

- Both review stages ran on the **agent** backend: the `review_plan` MCP tool (codex bridge) is not registered in this environment. Plan review took two rounds; code review approved in one with two minors, both fixed and verified by mutation before the report.
- Mutation testing is what caught the weakest test: deleting the `await` in `run()` left all 9 tests green until an async-rejecting-runner test was added. Worth repeating on anything that awaits.
- `storybloq` MCP reports a version skew (server v1.15.9 vs v0.0.1 installed); a Claude Code restart would clear it.

## Continuation

- **ISS-001** is the highest-value follow-up: a real request-path crash, small fix, and it is the half of the blank-id story T-2 could not close.
- **ISS-002** needs an owner decision before anyone can act on it.

## Carried forward

- T-3 — move AppLogger into `packages/logging` once a second service needs it. Untouched.
