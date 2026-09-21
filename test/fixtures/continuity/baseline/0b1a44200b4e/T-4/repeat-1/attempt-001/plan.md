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

> **Revision note.** Sections marked *(r1)* answered plan-review round 1 (test file location,
> limiter memory bounds, the anonymous-bucket tradeoff, the redaction claim, undefined semantics,
> the constructor parameter shape, the empty-request-id interaction). Sections marked *(r2)* answer
> round 2, whose findings were all introduced by the r1 fixes: the unimplementable `anonymousLimit`
> knob, the eviction policy's effect on third parties, the unstated denial direction of the threat
> model, and a cap test that would have certified nothing. Sections marked *(r3)* answer round 3,
> which found that r2's own dead-entry-first eviction scan was a provable no-op, that r2's tightened
> cap test carried an unsatisfiable `resetAt` assertion, and that the two test files had collided on
> case numbers. Nothing else changed.

### New module: `src/http/RateLimiter.ts`

A fixed-window counter, in-memory, dependency-free.

```ts
export interface RateLimitOptions {
  readonly limit: number;        // max requests per window per client
  readonly windowMs: number;     // window length
  readonly maxClients?: number;  // hard cap on tracked client ids, default 10_000
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

#### Semantics — fixed window, fully specified *(r1)*

State per client id: `{ windowStart: number, count: number }` in a `Map`. On `check(clientId)`:

1. **No entry for this client id** (the first-ever call for it): insert `{ windowStart: now, count: 1 }`
   and allow. `remaining = limit - 1`. This is the case round 1 found unstated.
2. **Entry exists and `now - windowStart >= windowMs`**: the window has elapsed. Reset to
   `{ windowStart: now, count: 1 }` and allow.
3. **Entry exists inside the window and `count < limit`**: increment and allow.
4. **Entry exists inside the window and `count >= limit`**: refuse, and do **not** increment — a
   refused request neither extends the window nor deepens the debt.

`resetAt = windowStart + windowMs`. `retryAfterSeconds = Math.ceil((resetAt - now) / 1000)`, floored
at 1 on a refusal so a client never sees `Retry-After: 0`; it is `0` when allowed.

**Client-id normalization** *(r1)*: the limiter treats the string it is given as opaque and does
**not** normalize. Normalization happens once, in the handler, so there is exactly one place that
decides what "the same client" means: trim surrounding whitespace, lowercase, and truncate to 200
characters. Lowercasing closes the round-1 hole where `Acme` and `acme` buy two windows; truncation
bounds the key size so a client cannot spend the limiter's memory on one enormous header value.

#### Memory bound *(r1)*

Round 1 was right: `x-client-id` is attacker-controlled, so "sweep entries older than one window"
bounds nothing — a caller rotating the header makes one fresh, unsweepable entry per request, and a
size-triggered full scan then runs on every request and evicts nothing. Replaced with a hard cap:

- The `Map` holds at most `maxClients` entries (default `10_000`). `Map` preserves insertion order,
  and entries are re-inserted (delete-then-set) both on first insert and whenever their window resets,
  so the front of the map is genuinely the least-recently-reset entry.
- **Eviction is front-only, and the front is always the oldest window** *(r3)*. When an insert would
  exceed the cap, delete the first entry the `Map` iterator yields, repeating until it fits (in
  practice once per insert). No scan, no sweep, no timers — O(1) per request.
- *Why there is no "evict a dead entry first" refinement.* Round 2 asked for one and r2 added a bounded
  dead-entry-first scan; round 3 showed it was a **provable no-op**, and it has been removed. The proof
  is worth keeping, because it is also what makes front-only eviction the right policy: every write
  path that changes `windowStart` (first insert, and window reset in case 2) is delete-then-set with
  `windowStart = now`, and the clock is monotonic, so `Map` insertion order *is* `windowStart` order.
  The front therefore always has the smallest `windowStart`; if any entry in the map is elapsed, the
  front one is elapsed too. A scan can never find a dead entry behind a live one, because that state
  is unreachable. Front-only eviction already evicts the dead entry whenever one exists.
- **Implementation constraint the invariant depends on** *(r4)*. Semantics case 3 (increment inside
  the window) **must mutate the entry in place and must NOT reinsert it**: `Map.set` on an existing
  key preserves the key's insertion position, and `windowStart` is unchanged, so order is preserved.
  Case 2 (window reset) **must** delete-then-set, because its `windowStart` moves. Getting either
  backwards — reinserting on case 3, or mutating in place on case 2 — silently breaks "front is
  oldest" and degrades eviction to arbitrary order. No test here distinguishes the two, which is
  exactly why it is written down as a constraint rather than left to the implementer's taste.
- Expired entries are not swept on a schedule; case 2 resets them on next contact (delete-then-set,
  per the constraint above) and the cap is what bounds memory.

#### Threat model *(r1, corrected in r2)*

`x-client-id` is a self-asserted, unauthenticated label. Everything below follows from that one fact.
Round 2 found the first version of this section stated only the bypass direction and drew a
too-comfortable conclusion from the eviction policy; it is restated here in full.

**What this limiter does.** It enforces fair sharing between *cooperating* clients — callers that
label themselves honestly and would otherwise starve each other by volume — and it bounds its own
memory under a hostile one.

**Bypass.** An attacker can rotate `x-client-id` and get a fresh window on every request. The limit is
not a defence against a caller who does not want to be limited.

**Denial** *(r2)*. This is the direction the first version omitted, and it is a capability the service
does not have today, since today no request is ever refused:

- *Impersonation.* Any caller can send a victim's client id `limit` times per window and push the real
  owner into 429s. There is no way to tell the two apart without authenticated identity.
- *Draining the shared bucket.* A caller can send `x-client-id: anonymous` (or `Anonymous` — the
  handler lowercases, so it folds into the same bucket) and spend the one window every header-less
  caller shares. Note this makes `"anonymous"` reachable from caller input, which the r1 text wrongly
  said it was not; rule 1 is unaffected either way, because the bytes logged are the same fixed
  literal whether the bucket was chosen by this code or named by a caller.

**Collateral eviction** *(r2)*. Round 2 is right that the r1 claim — "evicting a victim's counter only
ever grants requests, never denies them, so the cap cannot be used to deny service" — was true but
beside the point. The consequence it skipped: a caller emitting more than `maxClients` distinct ids
inside one window evicts *honest* clients' counters as a side effect, handing each of them a fresh
window on their next request. *(r3)* The r2 draft claimed a dead-entry-first scan "reduces this in the
ordinary case"; round 3 proved that scan a no-op and it is gone, so no mitigation is claimed here at
all. Nothing in this design blunts the attack: under it every entry is live, and front-only eviction
walks straight through the honest clients in `windowStart` order. It also gives an attacker a
self-reset: exhaust `acme`, rotate `maxClients` ids to push `acme` off the front, replay `acme` on a
fresh window. Stated plainly: **one hostile caller can neutralize the limiter for everyone.** Raising
`maxClients` raises the cost of that attack and the memory ceiling together; neither closes it.

**Why this is nevertheless the right change.** The ticket's stated problem is accidental starvation
between ordinary clients, and that is exactly what this fixes. Every limitation above has the same
root — the caller names itself — and the only real fix is an authenticated caller identity, which the
service does not have and this ticket does not introduce. Recorded here so it is a decision rather
than an oversight, and filed as an issue during implementation.

### Wiring: `src/http/handler.ts`

- `createApp` gains a third optional parameter: `createApp(queue?, sink?, rateLimit?: RateLimitOptions)`.
  *(r1)* The union with `RateLimiter` is dropped — every use this plan names is satisfied by the
  options object, and the union would need an `instanceof` discriminator for no stated benefit.
  Default: `{ limit: 60, windowMs: 60_000 }`. Optional and last, so every existing call site
  (including `router.test.ts`) keeps working unchanged.
- In `handle`:
  1. Resolve `requestId`. *(r1)* Round 1 found that today's `req.headers["x-request-id"] ?? randomUUID()`
     lets an empty-string header through, and `AppLogger.withRequestId` throws on a blank id. That is
     pre-existing (filed as **ISS-001**), but this ticket makes it worse: the refusal path below builds
     a logger *before* dispatch, so a rate-limited request with a blank `x-request-id` would throw
     instead of returning the 429 the ticket requires. This plan therefore changes the resolution to
     trim-and-fall-back (blank → `randomUUID()`), which is the minimum needed for this ticket's own
     429 path to be correct. Step 1 is no longer described as "unchanged".
  2. Derive the client bucket: take `req.headers["x-client-id"]`, trim, lowercase, truncate to 200
     chars *(r1)*; if the result is empty, use the literal bucket `"anonymous"`.
  3. `const verdict = limiter.check(clientId)`.
  4. If `verdict.allowed` is false, return `429` **without dispatching**, and log the refusal through
     `AppLogger.withRequestId(requestId, sink)` at `warn`, so rule 1 holds on the path that never
     reaches the router.
     - Response: `{ status: 429, body: { error: "rate limit exceeded" } }`.
     - `RouteResponse` has no `headers` field. Rather than widen the public response type for one
       path, the limit metadata goes in the log line and the body stays minimal. A `Retry-After`
       header is named in Out of scope below.
     - **Logged fields** *(r1)*: round 1 correctly rejected the earlier claim that "`AppLogger.redact`
       already covers it". There is no `AppLogger.redact` static — `redact()` is a module-level export
       that `AppLogger#emit` calls — and its coverage is key-based (`SECRET_KEY` does not match
       `clientId`) or shape-based (`sk-…`, `Bearer …`). A credential stuffed into `x-client-id` that
       matches neither pattern would be written verbatim. So the refusal line logs
       `{ clientIdHash, limit, retryAfterSeconds }`, where `clientIdHash` is the first 12 hex chars of
       `createHash("sha256").update(clientId).digest("hex")` (`node:crypto`, already a dependency of
       this file, so rule 2 holds). That is enough to correlate refusals for one client across lines
       without putting caller-controlled text in the log at all.
     - *(code review r1)* The r1 plan said `"anonymous"` would be logged as-is, "since it is a literal
       this code chose rather than caller input". Code review rejected that on two counts: the threat
       model already established a caller can *name* `anonymous`, and special-casing one id makes the
       field's meaning depend on its value. The implementation instead hashes **every** id uniformly
       and adds a separate boolean field `anonymous`. A saturated shared bucket — the day-one
       condition for every caller of this service — stays legible to an operator without reversing a
       hash, and no id is ever logged verbatim.
     - *(code review r1)* `RateLimitOptions` is validated in the constructor (`limit` a non-negative
       integer, `windowMs > 0`, `maxClients` a positive integer), and `limit: 0` refuses every
       request. Review found the two allow-paths inserted `count: 1` without consulting the limit, so
       the effective allowance was `max(limit, 1)` and `limit: 0` silently meant one request per
       window. `retryAfterSeconds` is additionally clamped to the window length, so a backwards
       `Date.now` step cannot ask a caller to wait longer than a window can last.
  5. Otherwise dispatch as today.

#### The anonymous bucket: an accepted, disclosed tradeoff *(r1)*

Round 1 is right that one shared `"anonymous"` bucket lets one unidentified caller starve the other
unidentified callers — the ticket's own opening complaint — and that it changes behaviour for the
entire current surface, since no caller in this repo sends `x-client-id` today (`router.test.ts`
sends only `x-request-id`). Three options were considered:

- *Fail open* (no limit without the header): rejected, the limit becomes bypassable by omitting a header.
- *Per-request identity for anonymous callers* (e.g. bucket by request id): rejected, it is per-request,
  so it is not a limit at all.
- *One shared bucket, disclosed*: chosen.

So, stated explicitly as the finding demands: **all traffic without an `x-client-id` header shares a
single window and collectively gets `limit` requests per window; they can starve each other, and on
day one that is every caller of this service.** This is accepted because the only fix that is not
cosmetic is an authenticated caller identity, which is outside this ticket.

*(r2)* The r1 draft also promised the anonymous bucket "its own `anonymousLimit` option". **That knob
is withdrawn.** Round 2 is right that it was unimplementable as written: it appeared in no interface,
and every way to honour it damages something this plan settled — special-casing the literal
`"anonymous"` inside `check` contradicts "the limiter treats the string it is given as opaque",
a per-call override changes the frozen `check(clientId)` signature, and a second `RateLimiter`
instance splits the `maxClients` budget across two maps. It also bought nothing: widening the shared
window does not stop anonymous callers starving each other, which is the property actually at issue.
`RateLimitOptions` is therefore exactly as shown above, with one `limit` that applies to every bucket
including `"anonymous"`. An operator who needs the distinction needs authenticated identity, which is
the same follow-up named in Out of scope.

## Test: `src/http/RateLimiter.test.ts`

Rule 3 puts the test next to the module it covers. Cases, all with an injected clock:

*(r3)* Cases are numbered **R1–R7** and the handler file's are **H1–H5**, so the two files no longer
collide on a case number. References elsewhere in this plan to "Semantics case 1/2" mean the numbered
semantics list, a separate namespace.

- **R1. Allows up to the limit, refuses the next.** `limit: 2` — two `check("c1")` allowed, third
  refused, `remaining` counts down 1, 0, 0.
- **R2. Per-client isolation (the starvation the ticket names).** `c1` exhausts its window; `c2`'s
  first request is still allowed. This is the assertion that proves the ticket's premise is addressed.
- **R3. Window rolls over.** After advancing the clock past `windowMs`, the refused client is allowed
  again and `remaining` is back to `limit - 1`.
- **R4. A refused request does not extend the window.** Refusals during an exhausted window leave
  `resetAt` where it was, so hammering the endpoint cannot push the reset out.
- **R5. `retryAfterSeconds` is at least 1 on a refusal** and `0` when allowed.
- **R6. The client cap bounds the map, observably** *(r1, tightened in r2, assertion fixed in r3)*.
  `{ limit: 1, maxClients: 3 }`. At `t0`: `check("c1")` allowed, `check("c1")` refused — `c1` is now
  exhausted, which is what makes its eviction observable. Then `check("c2")`, `check("c3")`,
  `check("c4")`; the fourth insert exceeds the cap and evicts `c1` (the front, and the oldest window).
  **Advance the clock to `t0 + 1`, still well inside the window** *(r3)*, then `check("c1")`.
  Assert `allowed === true` — the discriminating assertion, since without the cap `c1` would still be
  refused — and `resetAt === t0 + 1 + windowMs`, strictly greater than the original `t0 + windowMs`,
  which is only possible if the entry was dropped and re-created. Round 3 caught that the r2 wording
  froze the clock and then asserted a strictly later `resetAt`, which cannot hold: a re-insert at the
  same instant reproduces the same `resetAt`. Advancing by 1ms is what makes the clause true and
  meaningful. (`remaining === 0` is *not* asserted as evidence: a refusal reports 0 as well, so it
  discriminates nothing.)
  There is no companion "dead entries are evicted first" case, because *(r3)* that behaviour does not
  exist and cannot: see Memory bound — insertion order is `windowStart` order, so a dead entry behind
  a live one is unreachable.
- **R7. First-ever check for an id allows and reports `remaining = limit - 1`** *(r1)* — the
  absent-entry path stated in Semantics case 1.

## Test: `src/http/handler.test.ts` (new) *(r1)*

Round 1 is right that this belongs in `handler.test.ts`, not appended to `router.test.ts`: the module
whose behaviour changes is `handler.ts`, and rule 3 names the file after the changed module. The
pre-existing mis-location in `router.test.ts` (it imports `createApp` from `./handler.ts` and never
imports `router.ts`) is left alone — moving it is not this ticket's work — but this ticket does not
extend it further.

- **H1. 429 on an exhausted window, logged under the right request id.** Build with
   `createApp(undefined, sink, { limit: 1, windowMs: 60_000 })`. Send two requests with the same
   `x-client-id: "acme"` and **distinct, explicit** `x-request-id` values `req-1` and `req-2` *(r1)*.
   Assert: first is `202`; second is `429` with body `{ error: "rate limit exceeded" }`; the log line
   with `requestId === "req-2"` is the `warn` refusal; and **no** line with `requestId === "req-2"` has
   message `"report queued"` (proving the route never ran).
- **H2. Distinct `x-client-id` values do not share a window** at the handler level: with `limit: 1`,
  `acme` then `globex` both succeed.
- **H3. Client id normalization** *(r1)*: with `limit: 1`, `x-client-id: "Acme"` then `" acme "` —
  the second is `429`, proving trim + lowercase collapse to one bucket.
- **H4. A blank `x-request-id` on a rate-limited request still returns 429** *(r1)* and does not throw —
  the ISS-001 interaction named in Wiring step 1.
- **H5. The default limit does not trip on a single request** — `createApp()` with no rate-limit
  argument still returns `202`, so `router.test.ts` keeps passing unchanged.

## Verification

- `npm test` (`node --test`) — all tests green, including the pre-existing `router.test.ts` and
  `AppLogger.test.ts`, which this change does not modify.
- Manual read-through against RULES.md:
  - rule 1 — every new log line is emitted through `AppLogger`, so it carries the request id; the
    refusal path constructs its own logger because `Router.dispatch` is never reached. No
    caller-controlled string is logged: the client id is hashed *(r1)*.
  - rule 2 — the limiter imports nothing; the handler's only new import is `node:crypto` (already
    imported there for `randomUUID`).
  - rule 3 — new behaviour in `RateLimiter.ts` is covered by `RateLimiter.test.ts`, and new behaviour
    in `handler.ts` by `handler.test.ts`, each beside its module and named for it *(r1 — the earlier
    wording of this line was inaccurate and is corrected)*.

## Files touched

| File | Change |
|---|---|
| `src/http/RateLimiter.ts` | new — fixed-window per-client limiter, injectable clock, hard client cap |
| `src/http/RateLimiter.test.ts` | new — cases R1–R7 |
| `src/http/handler.ts` | wire the limiter into `handle`; 429 short-circuit with a request-id-bearing warn line; blank-`x-request-id` fallback |
| `src/http/handler.test.ts` | new *(r1)* — cases H1–H5 |

`src/http/router.ts`, `src/http/router.test.ts`, `src/jobs/JobQueue.ts`, and
`src/platform/logging/AppLogger.ts` are not modified *(r1 — `router.test.ts` moved out of this list)*.

## Out of scope (named, not silently dropped)

- A `Retry-After` response header — needs `RouteResponse.headers`, which this ticket does not ask for.
- Authenticated caller identity, which is what would make the limit unspoofable and would let the
  anonymous bucket be split *(r1)*. To be filed as an issue during implementation.
- Relocating the pre-existing `router.test.ts` handler tests into `handler.test.ts` *(r1)*.
- ISS-001 beyond the blank-id fallback this ticket's 429 path requires.
- Distributed/shared limiter state across processes — the service is single-process here.
- Sliding-window or token-bucket smoothing — the ticket specifies a fixed window.
- Per-route or per-method limits — the ticket specifies per-client.
