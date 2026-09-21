# Plan: T-4 — Add per-client rate limiting to the HTTP handler

## Ticket

> Requests from one client can starve the others. Add per-client rate limiting to the HTTP handler:
> a fixed window per client id (the `x-client-id` header), a 429 response when the window is
> exhausted, and a test.

Cited rulings: none.

## Constraints that bind this change

From `RULES.md`:
1. Every emitted log line carries the request id of the work it belongs to; secrets never reach a log line unredacted.
2. Node built-ins only — no dependencies.
3. A behaviour change ships with a test under the same directory, named `<Module>.test.ts`.

From `CLAUDE.md`: TypeScript run directly by Node 22 (type stripping), no build step; tests via `node --test`.

## Current shape

- `src/http/handler.ts` — `createApp(queue?, sink?)` returns `{ handle(req) }`. It mints/accepts the
  request id (`x-request-id` header, else `randomUUID()`), then calls `router.dispatch(...)`.
  This is the only place that sees raw `headers`, so it is the correct layer for the limiter.
- `src/http/router.ts` — `Router.dispatch` builds the `AppLogger` via `AppLogger.withRequestId(requestId, sink)`.
  Note: the logger is created *inside* dispatch, so a rejection that happens before dispatch must
  construct its own logger with the same sink to keep rule 1.
- `src/platform/logging/AppLogger.ts` — `AppLogger.withRequestId(requestId, sink)`; redaction is automatic.

## Design

### New module: `src/http/RateLimiter.ts`

A fixed-window counter, in-memory, dependency-free.

```ts
export interface RateLimitOptions {
  readonly limit: number;        // max requests per window per client
  readonly windowMs: number;     // window length
  readonly now?: () => number;   // injectable clock, defaults to Date.now
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;      // epoch ms when the current window ends
  readonly retryAfterSeconds: number; // 0 when allowed
}

export class RateLimiter {
  constructor(options: RateLimitOptions);
  check(clientId: string): RateLimitResult;
}
```

Semantics — fixed window, exactly as the ticket words it:
- State per client id: `{ windowStart: number, count: number }` in a `Map`.
- On `check(clientId)`: if `now - windowStart >= windowMs`, reset the window to
  `windowStart = now`, `count = 0`. Then if `count < limit`, increment and allow;
  otherwise refuse without incrementing (a refused request does not extend the window).
- `resetAt = windowStart + windowMs`. `retryAfterSeconds = Math.ceil((resetAt - now) / 1000)`,
  floored at 1 on a refusal so a client never sees `Retry-After: 0`.
- `now` is injectable so the test drives time deterministically — no timers, no sleeping.

Clock/bounds decisions, stated rather than left implicit:
- The clock is injectable, so the test controls it and does not depend on wall-clock timing.
- The `Map` grows one entry per distinct client id. Sweep stale entries lazily inside `check`:
  when the map exceeds a small threshold, drop entries whose window ended more than one window
  ago. This is unbounded-growth protection, not eviction policy; it keeps the module
  dependency-free and free of background timers.

### Wiring: `src/http/handler.ts`

- `createApp` gains a third optional parameter: `createApp(queue?, sink?, rateLimit?)`, where
  `rateLimit` is `RateLimitOptions | RateLimiter | undefined`. Default: a limiter with a
  documented default (`limit: 60`, `windowMs: 60_000`). Keeping the parameter optional and
  last preserves every existing call site, including `router.test.ts`.
- In `handle`:
  1. Resolve `requestId` as today (unchanged — the request id is still born here).
  2. Read the client id: `req.headers["x-client-id"]`. A missing or blank header falls back to
     the literal client bucket `"anonymous"`, so unidentified callers share one window and still
     cannot starve identified ones. (Alternative — fail open, no limiting without a header —
     rejected: it makes the limit trivially bypassable by omitting a header.)
  3. `const verdict = limiter.check(clientId)`.
  4. If `verdict.allowed` is false, return `429` **without dispatching**, and log the refusal
     through `AppLogger.withRequestId(requestId, sink)` at `warn` so rule 1 holds on the path
     that never reaches the router.
     - Response: `{ status: 429, body: { error: "rate limit exceeded" } }`.
     - `RouteResponse` currently has no `headers` field. Rather than widen the public response
       type for one path, the limit metadata goes in the log line
       (`{ clientId, limit: verdict.limit, retryAfterSeconds: verdict.retryAfterSeconds }`) and the
       body stays minimal. Widening `RouteResponse` with an optional `headers` to carry
       `Retry-After` is a larger change than this ticket asks for; if the reviewer wants the
       header on the wire, that is a follow-up issue, not a silent scope expansion here.
     - The client id is logged as a plain field; `AppLogger.redact` already covers it if a caller
       ever passes a secret-shaped value, so rule 1's second half holds without special-casing.
  5. Otherwise dispatch as today.

## Test: `src/http/RateLimiter.test.ts`

Rule 3 puts the test next to the module it covers. Cases, all with an injected clock:

1. **Allows up to the limit, refuses the next.** `limit: 2` — two `check("c1")` allowed, third refused,
   `remaining` counts down 1, 0, 0.
2. **Per-client isolation (the starvation the ticket names).** `c1` exhausts its window; `c2`'s first
   request is still allowed. This is the assertion that proves the ticket's premise is addressed.
3. **Window rolls over.** After advancing the clock past `windowMs`, the refused client is allowed again
   and `remaining` is back to `limit - 1`.
4. **A refused request does not extend the window.** Refusals during an exhausted window leave `resetAt`
   where it was, so hammering the endpoint cannot push the reset out.
5. **`retryAfterSeconds` is at least 1 on a refusal** and `0` when allowed.

## Test: `src/http/router.test.ts` (extended)

The handler wiring is a behaviour change in `handler.ts`, whose existing tests live in `router.test.ts`;
new cases are appended there rather than creating a competing file for the same module.

6. **429 on an exhausted window, with a logged warning under the request id.** Build the app with
   `createApp(undefined, sink, { limit: 1, windowMs: 60_000 })`, send two requests with the same
   `x-client-id`; assert the second is `status: 429`, and that the refusal log line carries the
   second request's `x-request-id` (rule 1) and does not reach the route handler (the route's own
   "report queued" line is absent for that request).
7. **Distinct `x-client-id` values do not share a window** at the handler level.
8. **The existing request-id test still passes unchanged** — the default limit must not trip on a
   single request.

## Verification

- `npm test` (`node --test`) — all tests green, including the pre-existing logger and router tests.
- Manual read-through against RULES.md: no new imports beyond `node:` built-ins (the limiter imports
  nothing), every new log line goes through `AppLogger`, tests sit beside their modules with the
  `<Module>.test.ts` name.

## Files touched

| File | Change |
|---|---|
| `src/http/RateLimiter.ts` | new — fixed-window per-client limiter, injectable clock |
| `src/http/RateLimiter.test.ts` | new — cases 1–5 |
| `src/http/handler.ts` | wire the limiter into `handle`, 429 short-circuit with a request-id-bearing warn line |
| `src/http/router.test.ts` | append cases 6–8 |

`src/http/router.ts`, `src/jobs/JobQueue.ts`, and `src/platform/logging/AppLogger.ts` are not modified.

## Out of scope (named, not silently dropped)

- A `Retry-After` response header — needs `RouteResponse.headers`, which this ticket does not ask for.
- Distributed/shared limiter state across processes — the service is single-process here.
- Sliding-window or token-bucket smoothing — the ticket specifies a fixed window.
- Per-route or per-method limits — the ticket specifies per-client.
