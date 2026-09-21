# T-4 — Per-client rate limiting in the HTTP handler

## Goal

One client must not be able to starve the others. Add a fixed-window,
per-client-id limiter in front of routing: requests are counted per
`x-client-id`, and once a client's window is exhausted the request is refused
with a 429 instead of reaching a route.

## Rulings that bind this work

T-4 cites no rulings. The current logging ruling **r-eftp2zdb6as643np**
("One logger, AppLogger; nothing else writes log lines. Every line carries the
request id of the work it belongs to, and secrets are redacted before the line
is written.") still governs, because this change introduces a new path that
emits a log line. That refusal line therefore goes through `AppLogger` bound to
the request id the handler just assigned — not `console`, not a bare sink write.

RULES.md constraints that apply: Node built-ins only (no dependency), and the
behaviour change ships with a test named `<Module>.test.ts` beside the module.

## Design

### New module: `src/http/RateLimiter.ts`

```ts
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;          // epoch ms when the current window ends
  readonly retryAfterSeconds: number; // 0 when allowed
}

export interface RateLimiterOptions {
  readonly limit?: number;            // default 100
  readonly windowMs?: number;         // default 60_000
  readonly now?: () => number;        // injectable clock, default Date.now
  readonly maxTrackedClients?: number; // default 10_000
}

export class RateLimiter {
  check(clientId: string): RateLimitDecision;
}
```

- **Fixed window, not sliding.** State per client is `{ windowStart, count }`.
  On `check`, if `now - windowStart >= windowMs` the window is reset to
  `{ windowStart: now, count: 0 }`. Then `count + 1 <= limit` decides.
  A denied request does **not** increment the count, so a client hammering a
  closed window cannot push its own reset time out.
- **Clock is injected** (`now`) so the test can exercise window rollover
  deterministically without sleeping.
- **Unbounded-growth guard.** The per-client map would otherwise grow with every
  distinct client id seen. When the map exceeds `maxTrackedClients`, `check`
  sweeps entries whose window has already expired before inserting a new one.
  Expired entries carry no state that matters — a fresh entry is identical to a
  reset one — so the sweep cannot change a decision.
- No timers, no intervals: the module stays inert between calls, which keeps it
  usable from a test without teardown.

### Handler wiring: `src/http/handler.ts`

`createApp` gains a third optional parameter so existing callers (including
`router.test.ts`) keep working unchanged:

```ts
export function createApp(
  queue: JobQueue = new JobQueue(),
  sink?: Sink,
  opts?: { rateLimit?: RateLimiterOptions },
): { handle(req: IncomingRequest): Promise<RouteResponse> }
```

Inside `handle`, in this order:

1. `requestId` is resolved exactly as today (`x-request-id` or `randomUUID()`) —
   the request id is still born here, and it is born *before* the limiter runs so
   a refused request is still traceable.
2. `clientId = req.headers["x-client-id"]`, trimmed. Missing or empty is bucketed
   under the single shared key `"anonymous"` rather than being waved through:
   exempting header-less requests would hand any client a trivial bypass of the
   very starvation this ticket is about. Header lookup is lowercase, matching the
   existing `x-request-id` handling.
3. `limiter.check(clientId)`. When `allowed` is false, build
   `AppLogger.withRequestId(requestId, sink)` and `log.warn("rate limited", {
   clientId, limit, retryAfterSeconds })`, then return
   `{ status: 429, body: { error: "rate limit exceeded", retryAfterSeconds } }`
   without dispatching.
4. Otherwise dispatch to the router exactly as today.

`RouteResponse` has no headers field, so `retryAfterSeconds` is carried in the
body. Widening the response shape to carry a real `Retry-After` header is out of
scope for this ticket and is not worth dragging the router's public type through;
if it is wanted later it is a separate change.

The limiter is constructed once per `createApp` call, so the window is per app
instance — which is what makes each test independent.

## Tests: `src/http/RateLimiter.test.ts`

Node's built-in test runner, matching the existing style.

1. **Fixed window admits up to the limit, then refuses.** `limit: 2` with a
   stubbed clock: two `check("c1")` calls allowed, third denied with
   `retryAfterSeconds > 0`.
2. **Clients are isolated.** `c1` exhausted; `c2`'s first request is still
   allowed — the starvation property the ticket names.
3. **The window resets.** Advance the stub clock past `windowMs`; the previously
   exhausted client is allowed again, `remaining` back to `limit - 1`.
4. **A denied request does not extend the window.** Deny twice inside one window,
   then advance just past the original `windowMs` and assert the client is
   allowed — proves the denied calls did not move `windowStart`.
5. **App-level 429.** `createApp(undefined, sink, { rateLimit: { limit: 1 } })`:
   first `POST /reports` returns 202, second returns 429 with
   `body.error === "rate limit exceeded"`, and the sink captured a `warn` line
   whose `requestId` is the request id of the refused request and whose message
   is `"rate limited"` — the ruling's request-id guarantee on the new path.
6. **No `x-client-id` shares one bucket.** Two header-less requests with
   `limit: 1`: the second is refused, showing header-less traffic is limited
   rather than exempt.

## Verification

- `npm test` — every existing test (`router.test.ts`, `AppLogger.test.ts`) must
  still pass unchanged; `router.test.ts` calls `createApp(undefined, sink)` with
  no options and must keep passing on the default limit.
- `npx tsc --noEmit` if the repo's `tsconfig.json` supports it, for type checking
  only (no build step is introduced).

## Out of scope

- Sliding-window or token-bucket algorithms; the ticket specifies a fixed window.
- Shared/persistent state across processes — the limiter is in-memory per app,
  matching how `JobQueue` is already scoped.
- A real `Retry-After` HTTP header (requires widening `RouteResponse`).
