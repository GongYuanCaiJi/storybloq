<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-4 per-client rate limiting (2026-09-20)

Targeted autonomous session, one item: T-4. Complete and committed as `f2e27ed` on `main`.

## Completed

- **T-4: per-client rate limiting on the HTTP handler.** New `src/http/RateLimiter.ts` (fixed window per key, `src/http/RateLimiter.test.ts` beside it); `src/http/handler.ts` checks the limit before dispatch and answers 429; new `src/http/handler.test.ts` for the end-to-end behaviour. Suite is 19/19.

## Decisions

- **Key namespacing.** Identified clients are keyed `id:<value>`; requests without a usable `x-client-id` share a separate sentinel bucket. Exempting header-less requests would have been a one-header bypass of the whole feature. Namespacing exists so a caller cannot pick an id that lands in the shared bucket and drain it, which would 429 every unidentified caller -- the starvation the ticket exists to prevent.
- **The check runs before `router.dispatch`**, so a 404 for an unknown path still costs the caller a slot. The limit protects the routes, not just the known ones.
- **Live windows are never evicted.** Expired entries are swept at most once per window, guarded by `#lastSweep`. A hard `maxEntries` cap was considered and rejected: capping means evicting a live window, which resets that client's allowance and hands an attacker a way to clear a victim's counter by flooding distinct ids. The accepted bound is therefore the number of distinct client ids seen across two consecutive windows, and it is written down in the module rather than left implicit.
- **`remaining` is computed post-increment.** Pre-increment would advertise a slot that does not exist. A test pins the countdown, because this is the kind of error that ships silently.
- **The clock is injectable** (`RateLimitOptions.now`), which is what makes the window tests deterministic without timers.
- **Header lookup is the lowercase key only**, matching how `handler.ts` already reads `x-request-id`. A caller sending `X-Client-Id` falls into the shared bucket -- a contention cost, not a bypass.
- **Logging** goes through `AppLogger.withRequestId` under the id the handler already assigned, so ruling `r-eftp2zdb6as643np` holds on this path. The limiter itself writes nothing.

## Review

The codex bridge was not callable in this session (no `review_plan` tool exposed, though `storybloq_health` reports the backend answers from the CLI side), so plan review and code review both ran on the agent backend. Two plan-review rounds and two code-review rounds.

The code review earned its keep. Round 1 found two majors, both in the tests, both demonstrated rather than asserted: an exact `retryAfterMs: 60_000` assertion running on the wall clock (reproduced failing ~1 run in 12), and a test named "a live window is never swept" that never triggered a sweep -- sabotaging the sweep to delete live windows left every test green. Round 2 re-verified all four round-1 fixes by sabotage, each producing exactly the expected single failing test, and confirmed the working tree was byte-identical to the reviewed diff afterwards.

**Lesson for future sessions here: a test that names a safety property is worth sabotaging once to confirm it can fail.** Both majors were tests that passed for the wrong reason, and neither would have been caught by reading them.

## Filed, not fixed

- **ISS-001** (medium) -- empty `x-request-id` throws out of `handle`: `??` does not fall back for an empty string and `AppLogger.withRequestId` rejects a blank id. Pre-existing, found during plan review.
- **ISS-003** (low) -- `RateLimiter` assumes a monotonic clock; a backwards `Date.now` step stalls windows and the sweep. Fix named in the issue (`performance.timeOrigin + performance.now()`, still a built-in).
- **ISS-004** (medium) -- **needs an owner decision before this runs anywhere real.** Limiting is on by default at 60 req/min, and every request without `x-client-id` shares one bucket, so a deployment whose clients omit the header gets an aggregate cap on the whole app including `GET /health`. A load balancer reads sustained 429s on health as instance death. Remedies (default `rateLimit` to null, or exempt `/health`) are both outside T-4's approved scope.
- **ISS-005** (low) -- `x-client-id` is unauthenticated, so rotating it per request bypasses the limit entirely. This is exactly what the ticket specified; it is a limit of a header-keyed limiter, not a defect in the change. The threat-model owner should decide whether the key needs to be something the caller cannot choose.

ISS-002 and ISS-006 were auto-filed by deferred dispositions and duplicate ISS-001 and ISS-004; both are resolved with a resolution pointing at the canonical issue.

## Continuation

**ISS-004 is the one to look at next** -- it is the only filed item that could bite in a real deployment, and it is a decision rather than an implementation. After that, T-3 (move AppLogger into `packages/logging`) is still carried forward from the T-1 session and still waiting on a second service needing it.

## Known gap

The `#sweep` throttle is what keeps the sweep from being a per-request O(n) scan under a flood of distinct keys, and no test fails if the throttle is removed. Sweep *correctness* is covered; the *amortization* claim rests on the comment. Pinning it needs either a timing assertion (flaky by nature) or a sweep counter on the production class -- a trade-off worth making deliberately rather than inside a review round. Left open on the record rather than quietly closed.
