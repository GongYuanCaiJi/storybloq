<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-2 failed jobs are traceable (2026-09-20)

## Completed
- **T-2** — `JobQueue.run()` now emits one `AppLogger` error line per failing job, bound to that job's own enqueuing request id. Commit `17a9306`. 20 tests pass.
- T-2 now cites **r-eftp2zdb6as643np** and **r-p19bbvh0jhj8xgma**; it cited neither when picked, so neither reached a reviewer until they were added.

## Decisions
- **The thrown value is normalised before it reaches the logger** (`describeThrown` in `src/jobs/JobQueue.ts`). Both obvious alternatives are wrong and were tried: `String(err)` throws on a null-prototype object and flattens `{ token: … }` into text that key-based redaction can no longer see; passing the raw value lets a `toJSON` survive `redact()` and be invoked by the sink, writing the secret back out (reproduced against the real stdout sink). The normaliser makes functions inert, marks cycles and repeats, caps depth (4) and breadth (24), unwraps boxed primitives, summarises byte views, and keeps an `Error`'s name and message at any depth.
- **`seen` is never released.** Releasing it per path let a shared, non-circular graph re-expand down every route: 7 small objects produced a 6.6 MB line, a wider case 352 MB. A value is now described once per line; later references render `[seen]`. Repeats are order-dependent as a result — accepted.
- **Key redaction moved into `AppLogger.redact`, not `JobQueue`.** `redact()` tested key names but only ever replaced values, so a secret in KEY position was written verbatim. The ruling puts redaction in the logger, and every caller logging an outside-controlled key map had the same hole. Two colliding secret-shaped keys now collapse to one `[REDACTED]` entry — diagnostic loss, no leak, and the fix for it would undo the redaction.
- **`createApp` owns its queue** (`createApp(sink?)`, queue read back from `App.jobs`). The `queue` parameter meant a caller-supplied queue kept its own sink, splitting where job-failure lines landed. No caller passed one.
- **`enqueue` refuses a blank or non-string request id.** Defence in depth only: `Router.dispatch` throws on a blank id first, so this is unreachable from HTTP today.

## Process note worth keeping
Four review rounds, and each of the first three found a real defect **introduced by the previous round's fix** — the round-2 fix caused a critical secret leak that round 1 had no way to anticipate. Reviewing the fix, not just the original code, is what caught them. Round 4 was run in-session rather than as an independent agent because the session budget was nearly spent; that round is less independent than the three before it, and the sole finding it raised was a suggestion.

## Next
- **ISS-001** (medium): a blank `x-request-id` header makes `handle()` throw instead of returning a response — `??` only substitutes for null/undefined. Verified at HEAD. Small fix: `req.headers["x-request-id"]?.trim() || randomUUID()`.
- **ISS-003** (low): `AppLogger.withRequestId` reports a non-string request id as a `TypeError` rather than its own error. The logger is the choke point, so the guard belongs there.
- ISS-002 and ISS-004 are resolved duplicates of ISS-001 and ISS-003. Both were auto-filed by reporting a finding with disposition `deferred` after the same finding had already been filed by hand — worth knowing before filing manually during a review round.
- **T-3** still carried forward: move `AppLogger` into `packages/logging` once a second service needs it. Note that it grew a behaviour this session (key redaction), so its tests moved with it matter.
- Known limitation, recorded in the session plan: cross-realm values (a `vm` context's `Error`) fail `instanceof` and render as `{}`. This service creates no realms.
