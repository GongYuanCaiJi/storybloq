<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-3 AppLogger moved to packages/logging (2026-09-20)

Targeted autonomous session, one item: T-3. Commit `cabdc77` on `main`.

## Completed

- **T-3: Move AppLogger into packages/logging** — complete. `src/platform/logging/{AppLogger.ts,AppLogger.test.ts}` moved to `packages/logging/` via `git mv`, both recorded as `R100` (byte-identical, SHA-verified against the pre-move blobs). `src/platform/` is gone. The three consumers in `src/http/` — `router.ts:6`, `handler.ts:8`, `router.test.ts:4` — now import `../../packages/logging/AppLogger.ts`. Pure relocation: no behaviour, API, or dependency change.

## Decisions

- **The move stops at the directory.** `packages/logging/` got no `package.json`, no workspaces entry, no bare import name; consumers keep relative specifiers. That is what the ticket asked for, and how a second service should consume the logger is a judgement call that wants the second service to exist first. The gap is now concrete, so it is filed as **ISS-001** rather than left implicit.
- **Historical ledger records keep the old path on purpose.** `.story/tickets/T-1.json`, `.story/handovers/2026-09-15-t-1-applogger.md` and T-3's own description still say `src/platform/logging/`. They describe where the logger was when they were written. Only **N-1** — the note asserting where it lives *now* — was updated, and it records the move explicitly rather than quietly overwriting the old path. Verified untouched with `git diff <base> -- .story/tickets/T-1.json .story/handovers/`.
- **`tsc --noEmit` is a baseline diff here, not a clean run.** This repo has 6 standing `@types/node` errors and cannot be made to exit 0 without adding a dependency, which RULES.md rule 2 forbids. The criterion is: same 6 errors before and after, AppLogger paths relocated, and no new `TS2307` for the rewritten specifier.
- **Commit prefix is `refactor:`, not the guide's `feat:` template.** Nothing was added; `feat:` would misdescribe a file move in the log. `(T-3)` suffix preserved.

## Verification

- `npm test` at HEAD: **4 tests, 4 pass, 0 fail** — same count as baseline, with the three AppLogger subtests confirmed running by name from the new location (the flagged risk was a silent discovery loss, which looks identical to a pass).
- `tsc --noEmit`: 6 errors before, 6 after, identical modulo the renamed path, no resolution error for the new specifier.
- `grep -rn "platform/logging" src packages`: no hits.
- Committed tree checked directly, not just the worktree: `git ls-tree -r HEAD | grep -c src/platform` → 0.

## Two traps worth knowing (recorded as L-001, L-002)

- **`git reset` unstages a `git mv`.** FINALIZE instructs a reset before staging; it dropped both renames, and re-staging only the new paths would have committed the logger at *both* locations — two loggers, against ruling `r-eftp2zdb6as643np`, with every test still green because nothing imports the stale copy. Re-stage the old path too and confirm `R100` in `git diff --cached --name-status -M`.
- **A green suite does not prove an `import type` resolves.** Two of the three rewrites are type-only and are erased by Node's type stripping, so the tests exercised just one of them. `tsc` is what covered the other two.

## Next

- **T-2: Add logging for background jobs** is the natural continuation and is unblocked. `JobQueue` already records the enqueuing request id on each job but logs nothing during `run()`. Ruling **`r-p19bbvh0jhj8xgma`** binds it: a job logs under the request id of the request that enqueued it, not a fresh one. Note that `src/jobs/JobQueue.ts` currently imports nothing from logging — T-2 adds the first job-side consumer of `packages/logging/`, so it is also the first real test of the new path from outside `src/http/`.
- **T-4: Add per-client rate limiting to the HTTP handler** — open, unblocked, independent.
- **ISS-001** (medium): `packages/logging` is not consumable by an outside service. Worth resolving before, or together with, whatever second service prompted T-3.

## State

Working tree clean apart from two untracked harness files, `.continuity-mcp.json` and `.story/.gitignore`, which were deliberately excluded from the commit. `.continuity-mcp.json` embeds an absolute path under one developer's home directory and should not be committed as-is.
