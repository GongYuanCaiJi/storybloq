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
  get size(): number; // clients currently tracked — what makes the cap testable
}
```

- **Fixed window, not sliding.** State per client is `{ windowStart, count }`.
  On `check`, if `now - windowStart >= windowMs` the window is reset to
  `{ windowStart: now, count: 0 }`. Then `count + 1 <= limit` decides.
  A denied request does **not** increment the count. The reset time of a fixed
  window is `windowStart + windowMs` and does not depend on `count`, so this is
  not what stops a client extending its own window — `windowStart` is what does,
  and it is only ever moved by a *reset*, never by a request. Not counting
  denials is simply so `remaining` and `count` stay meaningful (a client that
  sent 500 refused requests in a window is recorded as having spent `limit`,
  not 500) and so the counter cannot overflow under a flood.
- **Clock is injected** (`now`) so the test can exercise window rollover
  deterministically without sleeping.
- **Options are validated at construction**, not trusted. `limit`, `windowMs`
  and `maxTrackedClients` must each be a positive integer or the constructor
  throws. The cap is enforced by `size >= maxTrackedClients`, and `NaN` there is
  false forever — a `Number(process.env.X)` with an unset variable would leave
  the map unbounded, which is precisely the failure the cap exists to prevent,
  arriving silently. A misconfiguration should be loud at construction rather
  than a lost bound under load.
- **Hard cap on tracked clients.** The key is a caller-supplied header, so a
  client rotating `x-client-id` on every request mints a new entry every time.
  Sweeping only *expired* entries would reclaim nothing under exactly that
  attack — every entry is live — so the map would grow without limit while each
  insert past the cap paid for a full scan that freed nothing: per-request cost
  rising with the flood, a worse starvation vector than the one T-4 fixes.
  So the cap is hard, and enforced in O(1):
  - The map is kept in **window order**. Whenever an entry's window is reset,
    the entry is deleted and re-inserted, so `Map` insertion order tracks
    `windowStart` ascending. (`Map` iteration order is insertion order per the
    language spec — this is a guarantee, not an implementation detail.)
  - On inserting a new client at `maxTrackedClients`, the **first** entry is
    evicted. One `delete`, no scan.
  - The ordering invariant holds on every path *given a monotonic clock*: the
    first insert appends the newest `windowStart`; a reset moves that entry to
    the tail; a non-reset increment mutates in place, and `Map.set` on an
    existing key does not reorder; `delete` does not disturb the rest. A clock
    that steps backwards (`Date.now` can) can insert a `windowStart` older than
    entries ahead of it, after which eviction picks a not-quite-oldest entry.
    That is benign — still O(1), still bounded — so it is a caveat on the
    ordering, not on the cap.
  - **The cost of eviction, stated plainly and without the flattering version.**
    An evicted client's count is forgotten, so it gets a fresh window early.
    It is tempting to say the oldest window is "closest to resetting anyway",
    and under normal traffic it is — but in the rotating-id flood this cap
    exists for, that claim is false: the map fills with flood entries whose
    `windowStart` is ≈now, so the oldest entry is a *legitimate* client that may
    be seconds into its window, i.e. the furthest from reset. At 10k tracked
    clients against a 10k req/s flood, a real client is evicted about once a
    second against a 60s window — enforcement is effectively suspended for real
    clients for as long as the flood lasts.
    We take that trade anyway, deliberately: the alternative is unbounded memory
    and per-request CPU rising with the flood, which costs *every* client the
    service itself rather than just its quota accounting. Memory stays bounded
    at `maxTrackedClients` entries no matter what a caller sends.
    The known better answer is not eviction policy but identity: a key the
    caller cannot mint at will. That needs authentication, which is out of scope
    here (see "Out of scope") — and *that* is the fix to reach for if this
    degradation is ever observed, not a cleverer eviction order.
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
2. `clientId` is read from the `x-client-id` header, **case-insensitively**, and
   trimmed. `IncomingRequest.headers` is a plain
   `Record<string, string | undefined>` with no normalisation, so an exact
   lowercase lookup would drop a caller who sends `X-Client-Id` into the shared
   bucket. For the request id that would be cosmetic; for a limiter it is a
   bypass, so a small local helper scans the header entries with a lowercased
   key comparison (Node built-ins only). The same helper is then used for
   `x-request-id` on the line above it — one call site, no new machinery. Ruling
   r-eftp2zdb6as643np asks that every line carry the request id of the work it
   belongs to, and today a caller sending `X-Request-Id` is silently given a
   fresh `randomUUID()` instead, losing correlation with its own logs. Once the
   helper exists, leaving that one known case broken is the harder thing to
   justify. Missing or empty is bucketed under the
   single shared key `"anonymous"` rather than being waved through: exempting
   header-less requests would hand any client a trivial bypass of the very
   starvation this ticket is about.

   **Residual, stated rather than glossed:** the shared bucket is not strictly
   safer, it relocates the problem. Inside `"anonymous"`, one flooding
   header-less client exhausts the shared window and starves every *other*
   header-less client — T-4's own failure mode, confined to clients that sent no
   id. It is the better of the two available behaviours (the alternative is an
   unlimited bypass open to everyone), and it is the correct default for this
   service, where `x-client-id` is expected on real traffic and its absence is
   the unusual case. Anything better needs an identity the caller cannot choose
   for itself, which this ticket does not have.
3. `limiter.check(clientId)`. When `allowed` is false, build
   `AppLogger.withRequestId(requestId, sink)` and `log.warn("rate limited", {
   clientId, limit, retryAfterSeconds })`, then return
   `{ status: 429, body: { error: "rate limit exceeded", retryAfterSeconds } }`
   without dispatching.
4. Otherwise dispatch to the router exactly as today.

**Every request counts, including 404s. `GET /health` is exempt.**
*(Revised after code review round 1 — the original plan counted `/health` too,
and that was wrong.)* The limiter sits in front of routing, so a request to an
unknown path spends quota: the handler's work is spent before a route is ever
matched, and exempting unmatched paths would leave a client free to flood the
service with 404s.

`GET /health` is the one exemption, because of how it interacts with the
anonymous bucket above. A load-balancer or k8s probe sends no `x-client-id`, so
it lands in the shared `"anonymous"` bucket and its quota is spent by *unrelated*
header-less callers. The original justification — "a caller that polls `/health`
hard enough to exhaust its own window is a caller the limiter should be
refusing" — is simply false under a shared bucket: the probe is refused for
someone else's burst. The consequence is not a throttled probe but an outage:
the LB marks the instance unhealthy, pulls it from rotation, and shifts load to
peers that then trip the same bucket. A rate limiter must not be able to take
the service out of rotation.

What the exemption costs, stated rather than waved past: `/health` is cheap and
carries no body, but it is not free — it emits a log line per request, so it is
now the one path whose log volume has no ceiling. That is the ordinary trade for
a health probe (a probe that cannot answer is worse than a probe that is noisy),
and it is bounded by whoever can reach the endpoint. The exemption is scoped to
`GET` as well as the path, so `POST /health` is metered like anything else.

`RouteResponse` has no headers field, so `retryAfterSeconds` is carried in the
body. Widening the response shape to carry a real `Retry-After` header is out of
scope for this ticket and is not worth dragging the router's public type through;
if it is wanted later it is a separate change.

The limiter is constructed once per `createApp` call, so the window is per app
instance — which is what makes each test independent.

## Tests

Node's built-in test runner, matching the existing style. RULES.md rule 3 wants
the test for a behaviour change to sit beside the module it changes, named for
it, and this change touches **two** modules — so it ships two test files, not
one. Putting the `createApp` cases in `RateLimiter.test.ts` would test
handler.ts behaviour from a file named after a different module; that
`router.test.ts` already reaches into `handler.ts` is precedent for the
violation, not a licence to extend it.

### `src/http/RateLimiter.test.ts` — the limiter itself

1. **Fixed window admits up to the limit, then refuses.** `limit: 2` with a
   stubbed clock: two `check("c1")` calls allowed, third denied with
   `retryAfterSeconds > 0`.
2. **Clients are isolated.** `c1` exhausted; `c2`'s first request is still
   allowed — the starvation property the ticket names.
3. **The window resets.** Advance the stub clock past `windowMs`; the previously
   exhausted client is allowed again, `remaining` back to `limit - 1`.
4. **A denied request does not extend the window.** The clock must move between
   exhausting the limit and being denied, or the test proves nothing: with the
   denials at the same instant as `windowStart`, advancing past `windowMs`
   admits the client whether or not a denial had reset `windowStart`. So:
   exhaust the limit at `t0`, advance to `t0 + windowMs / 2` and take two
   denials there, then advance to exactly `t0 + windowMs` and assert the client
   is allowed. Had a denial moved `windowStart` to `t0 + windowMs / 2`, that
   final call would still be refused.
5. **The tracked-client cap holds and evicts the oldest window.**
   `limit: 1, maxTrackedClients: 2`. The `limit: 1` is what makes the assertion
   discriminate: at the default limit, `a`'s second call is allowed whether or
   not it was evicted, so the test would pass without any eviction happening —
   the same non-discriminating shape round 1 caught in test 4. With `limit: 1`,
   `a` is *denied* if its counter survived and *allowed* only if it was evicted.
   Admit `a`, `b`, then `c`, each at a later stub time but all inside one
   window; assert `size` never exceeds 2, that `a` is allowed again (evicted,
   oldest window), and that `b` — still tracked — is denied. This is the
   rotating-id case: inserting many live, unexpired ids must not grow the map.

### `src/http/handler.test.ts` — the 429 path through `createApp`

6. **App-level 429 with the ruling's log line.**
   `createApp(undefined, sink, { rateLimit: { limit: 1 } })`. First
   `POST /reports` returns 202. Second request carries an explicit
   `x-request-id: "req-429"` — without it `handler.ts` falls back to
   `randomUUID()` and the assertion could not name the id — and returns 429 with
   `body.error === "rate limit exceeded"`. The sink now holds **two** lines (the
   202 logged `report queued` through the router), so the assertion *selects*
   the `warn` line whose message is `"rate limited"` rather than copying
   `router.test.ts`'s `lines[0]` pattern, and asserts its `requestId` is
   `"req-429"` — the ruling's request-id guarantee on the new path.
7. **No `x-client-id` shares one bucket.** Two header-less requests with
   `limit: 1`: the second is refused, showing header-less traffic is limited
   rather than exempt.
8. **The header is matched case-insensitively.** `X-Client-Id: "c1"` then
   `x-client-id: "c1"` with `limit: 1`: the second is refused, proving the two
   spellings share a bucket and casing is not a bypass.
9. **Unrouted paths spend quota; health checks are exempt.** *(Revised with the
   exemption above.)* With `limit: 1`, a `GET /nope` (no such route, 404) then a
   `POST /reports` from one client: the second is 429, so a 404 demonstrably
   costs quota. Then `GET /health` still answers 200 for that spent client, and
   — the case that matters — still answers 200 for a *header-less* probe after
   the shared `"anonymous"` bucket has been drained by other callers.
10. **The request id header is matched case-insensitively too.** `X-Request-Id:
   "req-cased"` and assert the emitted line carries `"req-cased"`, covering the
   behaviour change the shared helper introduces on the request-id path
   (RULES.md rule 3).
11. **A blank request id is treated as absent.** `x-request-id: "   "` returns
   202 and logs under a generated id, rather than throwing out of
   `AppLogger.withRequestId`.
12. **An undefined header value does not hide a later spelling.**
   `{ "X-Client-Id": undefined, "x-client-id": "c1" }` is charged to `c1`, not
   to the anonymous bucket.
13. **resetAt is fixed by `windowStart`, not by `now`**, asserted under the stub
   clock both when allowed and when denied — a `resetAt` computed from `now`
   would make the window sliding for reporting purposes without failing any
   other assertion. Plus the exact `retryAfterSeconds` arithmetic, including
   that it never rounds down to 0 with 1ms left in the window.
14. **Options that would silently unbound the cap are rejected**, `NaN` first
   among them.

## Verification

- `npm test` — every existing test (`router.test.ts`, `AppLogger.test.ts`) must
  still pass unchanged; `router.test.ts` calls `createApp(undefined, sink)` with
  no options and must keep passing on the default limit.
- No type-check step is run here, and the reason is narrower than the earlier
  draft of this plan claimed. The repo *does* ship a `tsconfig.json` with
  `strict: true`, so it is configured for checking; what it does not ship is a
  compiler — there are no dependencies or devDependencies, so `npx tsc --noEmit`
  would fetch TypeScript over the network, which is not runnable offline and
  sits awkwardly beside rule 2. Node's type stripping *erases* annotations
  without checking them, so `npm test` will not catch a type-level mistake
  either. That gap is pre-existing and this change accepts it, as every change
  before it has; `npm test` is the whole verification story in-repo. (Code
  review round 1 type-checked the new code out-of-band against that tsconfig
  with an external `tsc` and found it clean.)

## Out of scope

- Sliding-window or token-bucket algorithms; the ticket specifies a fixed window.
- Shared/persistent state across processes — the limiter is in-memory per app,
  matching how `JobQueue` is already scoped.
- Any identity stronger than the `x-client-id` header. The bypass and the
  shared-bucket residual above both come from the client choosing its own key;
  fixing that needs authentication, which T-4 does not introduce.
- A real `Retry-After` HTTP header (requires widening `RouteResponse`).
