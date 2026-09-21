# Plan — T-4: Add per-client rate limiting to the HTTP handler

## Goal

Requests from one client must not starve the others. Add a fixed-window,
per-client-id rate limit at the HTTP entry point: the window is keyed on the
`x-client-id` header, an exhausted window answers `429`, and the behaviour is
covered by tests.

## Rulings

T-4 cites no rulings. One current ruling still binds part of this change
because the change emits a log line:

- **r-eftp2zdb6as643np** (current; supersedes r-rvcf99q7dwhzzpav) — "Logging
  keeps redaction and request ids on every path. One logger, AppLogger;
  nothing else writes log lines. Every line carries the request id of the work
  it belongs to, and secrets are redacted before the line is written."

  Consequence for this ticket: the rejection log line goes through
  `AppLogger.withRequestId(requestId, sink)` — the same request id
  `handler.ts` already assigns — and nothing in `RateLimiter` writes to
  stdout itself. The limiter takes no logger and does no logging; the handler
  logs the outcome.

r-fxdxynjdpcxprdhn (billing) and r-p19bbvh0jhj8xgma (background jobs) do not
touch this path.

## Constraints (RULES.md)

1. Every log line carries its request id, secrets redacted — satisfied by
   logging through `AppLogger` bound to the request id (above).
2. Node built-ins only — no new dependency; the limiter is a plain `Map`.
3. A behaviour change comes with a test under the same directory named
   `<Module>.test.ts` — `src/http/RateLimiter.test.ts` for the new module and
   `src/http/handler.test.ts` for the changed one. (`router.test.ts` today
   covers `createApp` from `handler.ts`; that pre-existing misplacement is left
   alone rather than extended.)

## Design

### New: `src/http/RateLimiter.ts`

```ts
export interface RateLimitOptions {
  readonly limit: number;        // requests allowed per window; must be >= 1
  readonly windowMs: number;     // window length; must be >= 1
  readonly now?: () => number;   // injectable clock; defaults to Date.now
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;    // requests left in the current window
  readonly retryAfterMs: number; // 0 when allowed
}

export class RateLimiter {
  constructor(opts: RateLimitOptions);
  check(key: string): RateLimitResult;
  /** Number of tracked keys. Exists so the sweep is observable from a test. */
  readonly size: number;
}
```

The constructor rejects `limit < 1` or `windowMs < 1` with a thrown `Error`, so
a misconfigured call fails loudly instead of quietly 429-ing every request.

Fixed window, exactly as the ticket specifies (not sliding, not token bucket):
per key the limiter stores `{ windowStart, count }`. This is the single
formulation of `check(key)` — the eviction paragraph below does not restate it:

1. look up the entry. **If there is none, or if `now - windowStart >= windowMs`**
   (the window expired), install a fresh `{ windowStart: now, count: 0 }` and
   fall through. A first request and an expired window take the same branch,
   which is why no separate first-request case is needed.
2. if `count < limit`: **increment `count` first, then**
   `remaining = limit - count`, and return `{ allowed: true, remaining,
   retryAfterMs: 0 }`. Post-increment is the binding detail: the first allowed
   call of a `limit: 5` window reports `remaining: 4`, and the last allowed one
   reports `0`. Pre-increment would advertise a slot that does not exist.
3. otherwise return `{ allowed: false, remaining: 0, retryAfterMs:
   windowStart + windowMs - now }`.

`check` is the only mutation point, so one request consumes exactly one slot.

**Clock.** Injected as `now: () => number`, defaulting to `Date.now`. That is
what makes the window test deterministic without touching timers or sleeping.

**Memory bound, stated honestly.** A `Map` keyed by a caller-supplied header
grows with the number of distinct keys seen. The bound this design accepts is
**the number of distinct client ids seen across two consecutive windows** — a
flood of N distinct ids inside a single `windowMs` produces N entries, and none
of them is evictable, because every one is a live window whose count is
load-bearing. Two windows rather than one because the sweep is throttled (see
below): an entry that expires just after a sweep is not removed until the next
one, up to a full `windowMs` later. That is inherent to
fixed-window-per-client plus an amortised sweep, and is not something the sweep
can tighten without paying the per-request scan it exists to avoid.

What the sweep does fix is entries outliving their window: once per `windowMs`
at most, guarded by a `#lastSweep` timestamp, `check` walks the map and deletes
entries whose windows have expired. `#lastSweep` is initialised to `now()` at
construction, so a freshly built limiter does not sweep an empty map on its
first call. An expired entry is identical to no entry, so this cannot change a
verdict. The once-per-window guard is what keeps the walk from becoming a
per-request O(n) scan under exactly the flood this ticket is meant to survive.

No hard `maxEntries` cap: capping would mean evicting a *live* window, which
resets that client's allowance and hands an attacker a way to clear a victim's
counter by flooding distinct ids. If a hard cap is ever wanted, it needs its own
ticket and an eviction order chosen with that trade-off in view.

### Changed: `src/http/handler.ts`

`createApp` gains an options argument rather than a fourth positional
parameter, keeping the existing `createApp(queue, sink)` call in
`router.test.ts` working:

```ts
createApp(
  queue: JobQueue = new JobQueue(),
  sink?: Sink,
  opts?: { rateLimit?: RateLimitOptions | null },
)
```

The `queue: JobQueue = new JobQueue()` default is kept exactly as it is today.
`router.test.ts` calls `createApp(undefined, (l) => lines.push(l))` and depends
on it; weakening the parameter to `queue?: JobQueue` would make
`queue.enqueue` a call on `undefined` (and a compile error under `strict`).

Default: `{ limit: 60, windowMs: 60_000 }` — 60 requests per minute per client.
Passing `rateLimit: null` disables limiting (useful to tests that are not about
it). The limiter instance is created once per app, so the window is shared
across requests to that app, which is the point.

In `handle`, after the request id is resolved and **before** `router.dispatch`:

1. Read the header, coalescing **before** trimming — the header type is
   `Record<string, string | undefined>`, so trimming first throws a TypeError
   on a missing header:

   ```ts
   const raw = (req.headers["x-client-id"] ?? "").trim();
   const key = raw === "" ? ANON_KEY : `id:${raw}`;
   ```

2. `limiter.check(key)`; when `allowed` is false, log
   `log.warn("rate limited", { clientId: raw === "" ? "(none)" : raw, retryAfterMs })`
   through `AppLogger.withRequestId(requestId, sink)` and return
   `{ status: 429, body: { error: "rate limited", retryAfterMs } }` without
   dispatching.
3. Otherwise dispatch as today.

Checking before dispatch is deliberate: the limit must protect the routes, and
a 404 for an unknown path should still cost the caller a slot.

**Key namespacing.** Identified clients are keyed `id:<value>` and the shared
unidentified bucket is a distinct sentinel (`ANON_KEY`, a module-private
constant that cannot collide with an `id:`-prefixed key). Without the prefix, a
caller sending `x-client-id: anonymous` would land in the unidentified bucket
and could drain it deliberately, 429-ing every header-less caller — the
starvation this ticket exists to prevent.

**Missing or empty `x-client-id` — stated assumption.** Requests without the
header share one bucket rather than bypassing the limit. Skipping the check
when the header is absent would let any caller opt out of rate limiting by
dropping a header, which defeats the ticket's purpose. The trade-off is that
unidentified callers contend with each other; that is the safer direction and
is recorded here so it can be revisited.

**Header lookup is the lowercase key only — stated decision.** `headers` is a
plain object with no case folding, and `handler.ts` already reads
`x-request-id` the same way. A caller sending `X-Client-Id` therefore falls
into the shared unidentified bucket. That is a contention cost, not a bypass:
the request is still limited. Normalising header case across the service is a
separate change and is out of scope here, but the behaviour is written down
rather than left for the implementer to discover.

**Header values are not secret-shaped**, but the client id still flows through
`AppLogger`'s `redact`, so a caller who puts a `sk-…`/`Bearer …` token in the
header gets it redacted in the log line rather than written out. No extra work
needed — it falls out of logging through AppLogger.

## Tests

`src/http/RateLimiter.test.ts` (new), with a controlled clock:

1. allows exactly `limit` requests inside one window and rejects the next, and
   **`remaining` counts down `limit-1 … 0`** across those allowed calls — the
   assertion that pins post-increment, without which the off-by-one ships
   silently;
2. a new window after `windowMs` restores the full allowance (and the first
   call in the new window reports `remaining: limit - 1`);
3. two client ids do not consume each other's allowance (the starvation case
   the ticket is about);
4. a rejection reports `remaining: 0` and `retryAfterMs` equal to the time left
   in the current window;
5. expired entries are swept rather than accumulating: with a short `windowMs`,
   check several distinct keys, advance the clock past the window, check one
   more key, and assert `limiter.size` has dropped to the live entries only —
   then assert the swept keys still get the same verdict they would have got
   from an untouched limiter. This is what the `size` getter on the class is
   for; without it the case is unwritable.

`src/http/handler.test.ts` (new — the behaviour change is in `handler.ts`, and
RULES.md rule 3 asks for `<Module>.test.ts` beside the module; `router.test.ts`
stays as it is):

6. with `{ limit: 1, windowMs: 60_000 }` and a `JobQueue` the test constructs
   itself, the first `POST /reports` for `x-client-id: c1` returns 202 and the
   second returns 429. Assert `queue.size === 1` **at that point, before
   issuing c2's request** — proving the 429 did not enqueue. Then `c2` gets
   202 (and `queue.size` becomes 2), proving one client's exhaustion does not
   starve another;
7. the 429 emits a log line whose `requestId` is the id the handler layer
   assigned (ruling r-eftp2zdb6as643np). The injected sink will hold the 202's
   `"report queued"` line as well, so assert on the line filtered by
   `level === "warn"` and `message === "rate limited"` — not on
   `lines.length === 1`.

The existing `router.test.ts` request-id test must keep passing unchanged,
which is the check that the default limit does not disturb ordinary traffic.

## Steps

1. Write `src/http/RateLimiter.ts`.
2. Write `src/http/RateLimiter.test.ts` (cases 1–5).
3. Wire the limiter into `src/http/handler.ts` (options arg with the `queue`
   default preserved, pre-dispatch check, 429, AppLogger warn line).
4. Write `src/http/handler.test.ts` (cases 6–7).
5. `npm test` — all tests green, including the pre-existing ones.

## Out of scope

- Distributed/shared state across processes: this is per-process, in-memory,
  matching the service's current single-process shape.
- Sliding windows, token buckets, per-route limits, `Retry-After` as a real
  HTTP header (`RouteResponse` carries no headers today).
- A hard `maxEntries` cap on tracked keys, and header-name case folding — both
  are decided against above, with the reasoning, rather than left open.
- ISS-001 (empty `x-request-id` throws out of `handle`): a pre-existing defect
  found during plan review, filed rather than fixed here.
- Configuration from the environment; the limit is a call-site option.
