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
   `<Module>.test.ts` — `src/http/RateLimiter.test.ts` for the new module, plus
   an end-to-end case in the existing `src/http/router.test.ts` (the file that
   already covers `handler.ts`).

## Design

### New: `src/http/RateLimiter.ts`

```ts
export interface RateLimitOptions {
  readonly limit: number;        // requests allowed per window
  readonly windowMs: number;     // window length
  readonly now?: () => number;   // injectable clock; defaults to Date.now
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;    // requests left in the current window
  readonly retryAfterMs: number; // 0 when allowed
}

export class RateLimiter {
  check(clientId: string): RateLimitResult;
}
```

Fixed window, exactly as the ticket specifies (not sliding, not token bucket):
per client id the limiter stores `{ windowStart, count }`. On `check`:

- if `now - windowStart >= windowMs`, start a fresh window (`windowStart = now`,
  `count = 0`);
- if `count < limit`, increment and allow, `remaining = limit - count`;
- otherwise reject with `retryAfterMs = windowStart + windowMs - now`.

`check` is the only mutation point, so one request consumes exactly one slot.

**Clock.** Injected as `now: () => number`, defaulting to `Date.now`. That is
what makes the window test deterministic without touching timers or sleeping.

**Unbounded growth.** A `Map` keyed by an attacker-supplied header grows
without bound if nothing evicts it. Every `check` first drops the accessed
key's entry if its window has expired, and additionally sweeps entries whose
windows have expired once the map exceeds a `maxEntries` threshold
(default 10_000). An expired entry carries no state that matters — a fresh
window is identical to no entry — so eviction cannot change a verdict.

### Changed: `src/http/handler.ts`

`createApp` gains an options argument rather than a fourth positional
parameter, keeping the existing `createApp(queue, sink)` call in
`router.test.ts` working:

```ts
createApp(queue?: JobQueue, sink?: Sink, opts?: { rateLimit?: RateLimitOptions | null })
```

Default: `{ limit: 60, windowMs: 60_000 }` — 60 requests per minute per client.
Passing `rateLimit: null` disables limiting (useful to tests that are not about
it). The limiter instance is created once per app, so the window is shared
across requests to that app, which is the point.

In `handle`, after the request id is resolved and **before** `router.dispatch`:

1. `clientId = req.headers["x-client-id"]`, trimmed.
2. `limiter.check(clientId)`; when `allowed` is false, log
   `log.warn("rate limited", { clientId, retryAfterMs })` through
   `AppLogger.withRequestId(requestId, sink)` and return
   `{ status: 429, body: { error: "rate limited", retryAfterMs } }` without
   dispatching.
3. Otherwise dispatch as today.

Checking before dispatch is deliberate: the limit must protect the routes, and
a 404 for an unknown path should still cost the caller a slot.

**Missing or empty `x-client-id` — stated assumption.** Requests without the
header share one bucket under the key `"anonymous"` rather than bypassing the
limit. Skipping the check when the header is absent would let any caller opt
out of rate limiting by dropping a header, which defeats the ticket's purpose.
The trade-off is that unidentified callers contend with each other; that is the
safer direction and is recorded here so it can be revisited.

**Header values are not secret-shaped**, but the client id still flows through
`AppLogger`'s `redact`, so a caller who puts a `sk-…`/`Bearer …` token in the
header gets it redacted in the log line rather than written out. No extra work
needed — it falls out of logging through AppLogger.

## Tests

`src/http/RateLimiter.test.ts` (new), with a controlled clock:

1. allows exactly `limit` requests inside one window and rejects the next;
2. a new window after `windowMs` restores the full allowance;
3. two client ids do not consume each other's allowance (the starvation case
   the ticket is about);
4. `retryAfterMs` on a rejection is the time left in the current window;
5. expired entries are evicted rather than accumulating (verdicts unchanged
   after eviction).

`src/http/router.test.ts` (extended), end to end through `createApp`:

6. with `{ limit: 1, windowMs: 60_000 }`, the first `POST /reports` for
   `x-client-id: c1` returns 202 and the second returns 429 with no job
   enqueued, while `c1`'s exhaustion leaves `c2` at 202;
7. the 429 emits one log line whose `requestId` is the id the handler layer
   assigned (ruling r-eftp2zdb6as643np) — asserted against the injected sink,
   the way the existing test does.

The existing request-id test must keep passing unchanged, which is the check
that the default limit does not disturb ordinary traffic.

## Steps

1. Write `src/http/RateLimiter.ts`.
2. Write `src/http/RateLimiter.test.ts` (cases 1–5).
3. Wire the limiter into `src/http/handler.ts` (options arg, pre-dispatch
   check, 429, AppLogger warn line).
4. Extend `src/http/router.test.ts` (cases 6–7).
5. `npm test` — all tests green, including the pre-existing ones.

## Out of scope

- Distributed/shared state across processes: this is per-process, in-memory,
  matching the service's current single-process shape.
- Sliding windows, token buckets, per-route limits, `Retry-After` as a real
  HTTP header (`RouteResponse` carries no headers today).
- Configuration from the environment; the limit is a call-site option.
