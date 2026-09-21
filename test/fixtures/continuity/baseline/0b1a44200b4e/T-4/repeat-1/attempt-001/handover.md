<!-- 2026-09-20-01-auto-session.md -->
# Session Handover — T-4 per-client rate limiting

**Session:** b5a59916 (targeted auto, 1 target)
**Result:** T-4 complete, committed as `868fcae` on `main`. Tests 24/24.

## What was done

T-4 asked for per-client rate limiting on the HTTP handler: a fixed window keyed on `x-client-id`, a 429 when the window is exhausted, and a test.

- **`src/http/RateLimiter.ts`** (new) — fixed-window counter, dependency-free, injectable clock. Bounded by `maxClients` (default 10,000) with front-only eviction. Options validated in the constructor; `limit: 0` refuses everything; `retryAfterSeconds` clamped to the window length.
- **`src/http/handler.ts`** — third optional `RateLimitOptions` param on `createApp` (default 60/60,000s). Normalizes the client id once (trim, lowercase, truncate to 200), falls back to a shared `"anonymous"` bucket, and short-circuits with 429 **before** `router.dispatch`. Also now trims `x-request-id` and falls back to `randomUUID()`.
- **`src/http/RateLimiter.test.ts`**, **`src/http/handler.test.ts`** (new) — 11 and 8 cases. `router.test.ts` is untouched and still passes.

## Decisions worth carrying forward

1. **The limiter keys on a self-asserted header, and that is a disclosed limitation, not an oversight.** `x-client-id` is unauthenticated, so the feature addresses *accidental* starvation between cooperating clients and nothing more. Three consequences are recorded in **ISS-003**: bypass (rotate the header for a fresh window every request), impersonation (send a victim's id to push them into 429s — a denial capability the service did not have before this ticket), and collateral eviction (a caller emitting more than `maxClients` distinct ids inside one window evicts honest clients' counters, so one hostile caller can neutralize the limiter for everyone, and can self-reset by pushing its own exhausted entry off the front). The only non-cosmetic fix is authenticated caller identity. **Do not "harden" the limiter without that** — every mitigation attempted during planning was either cosmetic or provably a no-op.

2. **Eviction is front-only, and that is correct rather than lazy.** Every write path that moves `windowStart` does delete-then-set; the in-window increment mutates in place and must NOT reinsert. Given a non-decreasing clock, Map insertion order *is* `windowStart` order, so the front is always the oldest window. A "prefer evicting a dead entry" refinement was written, reviewed, and **removed as a provable no-op**: a dead entry behind a live one is unreachable. If someone proposes adding that scan back, this is the argument against it.

3. **Every client id is hashed before it reaches a log line**, including the `anonymous` literal, with a separate boolean `anonymous` field for legibility. `AppLogger`'s redaction is key-based (`SECRET_KEY` does not match `clientId`) and shape-based (`sk-…`, `Bearer …`), so a credential stuffed into `x-client-id` matching neither would otherwise be written verbatim — rule 1 does not cover this automatically.

4. **All traffic without an `x-client-id` shares one window.** Nothing in this repo sends the header today, so on day one that is every caller, sharing a single 60/min window. Accepted and disclosed; an `anonymousLimit` knob was designed and then withdrawn as unimplementable (it fit no interface and every way to honour it broke something the plan had settled).

## Ledger changes

- **T-4** → complete.
- **ISS-001** (blank `x-request-id` throws instead of falling back) → **resolved**. Not deferrable: the 429 path builds a logger before `dispatch`, so a rate-limited request with a blank header would have thrown instead of returning 429.
- **ISS-002** → resolved as a **duplicate of ISS-001**. It was auto-filed by a plan-review finding marked `deferred` while I had already filed the same defect by hand. See the lesson.
- **ISS-003** (unauthenticated `x-client-id` threat model) → **open**, the real follow-up from this ticket.

## Process notes

- **Codex was unavailable this session.** `storybloq_health` reports the bridge as ok, but the bridge's `review_plan` tool is not registered in this client session (only the storybloq MCP server is), so every plan and code review ran through the sanctioned agent fallback. Anyone re-running this should expect the same unless the bridge is registered.
- **Plan review took 4 rounds**, and rounds 2 and 3 found defects introduced by the *previous round's fixes* — an unimplementable knob, then a no-op optimization. Worth knowing that the fix for a review finding is itself prime territory for the next one.
- Both the cap test and the limit-0 test were **mutation-checked**: reverting the feature makes them fail. Cheap, and it caught that an earlier draft of the cap test would have certified nothing.

## What's next

No target work remains in this session. The open backlog item arising from it is **ISS-003**. Nothing is blocked; the working tree is clean apart from an untracked `.continuity-mcp.json` and `.story/.gitignore`, both pre-existing and deliberately left alone.
