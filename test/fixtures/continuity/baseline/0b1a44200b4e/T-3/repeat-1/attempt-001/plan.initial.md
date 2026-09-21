# Plan: T-3 — Move AppLogger into packages/logging

## Goal

Move `src/platform/logging/` to `packages/logging/` keeping the same file names, update every
import that points at the old location, and keep the test suite passing from the new location.
This is a pure relocation: no behaviour change, no API change, no new dependency.

## Rulings

T-3 cites no rulings (`citedRulings: []`), so the plan-pin gate has nothing to satisfy. The
decision that nonetheless bounds this work is the current logging ruling
**`r-eftp2zdb6as643np`** — "One logger, AppLogger; nothing else writes log lines. Every line
carries the request id of the work it belongs to, and secrets are redacted before the line is
written." It is the current record in its chain (it supersedes the shorter 2026-09-10 wording
`r-rvcf99q7dwhzzpav`). Relevant here as a constraint to preserve, not to change: after the move
there must still be exactly one logger, at exactly one path, and the redaction plus request-id
guarantees must still be the ones `AppLogger.test.ts` covers.

`r-p19bbvh0jhj8xgma` (background work carries the enqueuing request id) is logging-scoped but
belongs to T-2, which is untouched here.

## Current state

Files to move (2):

| From | To |
|---|---|
| `src/platform/logging/AppLogger.ts` | `packages/logging/AppLogger.ts` |
| `src/platform/logging/AppLogger.test.ts` | `packages/logging/AppLogger.test.ts` |

Inbound imports of the old path — the complete set, from a repo-wide grep for
`platform/logging`:

| File | Line | Current specifier | Becomes |
|---|---|---|---|
| `src/http/router.ts` | 6 | `../platform/logging/AppLogger.ts` | `../../packages/logging/AppLogger.ts` |
| `src/http/handler.ts` | 8 | `../platform/logging/AppLogger.ts` | `../../packages/logging/AppLogger.ts` |
| `src/http/router.test.ts` | 4 | `../platform/logging/AppLogger.ts` | `../../packages/logging/AppLogger.ts` |

`AppLogger.test.ts` imports `./AppLogger.ts` — relative to its sibling, so it travels with the
move and needs no edit. `src/jobs/JobQueue.ts` imports nothing from logging.

Baseline before any change: `npm test` → 4 tests, 4 pass, 0 fail.

## Steps

1. **Create the destination and move both files with `git mv`.** `mkdir -p packages/logging`,
   then `git mv` each file. `git mv` rather than `mv` so the rename is recorded as a rename and
   the file history follows — the whole point of the ticket is that this code is about to be
   shared, and a second service's authors will want its history.
2. **Remove the vacated directories.** `src/platform/logging/` and then `src/platform/` are both
   empty after the move; git does not track directories, so this is only a working-tree tidy
   (`rmdir`), and it must not run before step 1 has succeeded.
3. **Rewrite the three import specifiers** in `src/http/router.ts`, `src/http/handler.ts`, and
   `src/http/router.test.ts`, exactly as tabled above. Explicit `.ts` extensions are kept:
   `tsconfig.json` sets `module: NodeNext` with `allowImportingTsExtensions` and the repo runs
   under Node's type stripping with no build step, so the extension is load-bearing.
4. **Verify no reference to the old path survives.** `grep -rn "platform/logging"` over the repo
   (excluding `.git/` and `.story/sessions/`) must return nothing. This is the check that step 3
   was complete rather than merely plausible — the table is from a grep, but the grep is also how
   the claim gets confirmed after the edit.
5. **Run `npm test`.** Expect the same 4 tests passing. Two things are being confirmed at once,
   and it is worth naming the second: that the three rewritten imports resolve, and that
   `node --test` (bare, no path argument, per `package.json`) still *discovers*
   `packages/logging/AppLogger.test.ts` at its new location. Node 22's default discovery walks the
   cwd recursively, so `packages/` should be picked up without a script change — but a test that
   silently stops being discovered looks identical to a test that passes, so assert on the
   **count**: 4, not merely "0 failed". If the count drops, the fix is to make the discovery
   explicit in the `test` script rather than to accept a smaller suite.
6. **Type-check.** `npx tsc --noEmit`. `tsconfig.json` already has `include: ["src", "packages"]`,
   so `packages/logging/` is in the program with no config edit needed — this step confirms that
   rather than assuming it. (Contingency: if `tsc` is not resolvable offline in this environment,
   record that it was skipped and why; do not silently drop the step.)
7. **Update note N-1** (`storybloq_note_update`). N-1 "AppLogger: where it lives and what it
   guarantees" states in its first line that AppLogger lives at
   `src/platform/logging/AppLogger.ts`. That path is the note's subject, so the move makes the
   record wrong, and N-1 is exactly what the next session reads to find the logger. Change the
   path; leave the contract paragraph and the `r-eftp2zdb6as643np` reference alone. N-2 names only
   `src/http/router.ts` and `src/http/handler.ts`, neither of which moves — no edit.

## Out of scope

- Turning `packages/logging/` into a real workspace package (its own `package.json`, a name the
  second service can `import` by, a workspaces entry in the root manifest). The ticket says move
  the directory and fix the imports; the consumers here keep using relative specifiers, which
  works and is what "same file names, update every import" describes. Packaging it properly is a
  judgement call about how the second service will consume it, and that service does not exist
  yet — file it as an issue if the move makes the gap concrete.
- Any change to `AppLogger`'s behaviour, API, or tests. The file content moves byte-identical
  apart from nothing at all; only its path changes.
- T-2 (background job logging) and T-4 (rate limiting).

## Risks

- **Silent test-discovery loss** — the one real risk, and step 5 is aimed squarely at it. Asserting
  the passing count is 4 is what distinguishes "still green" from "green because it stopped
  looking."
- **A missed import** — low: three call sites, all found by grep, and step 4 re-greps. A miss
  fails loudly at test time anyway, since the module would not resolve.
- **Stale ledger prose** — N-1 is the only record that names the old path (step 7). `CLAUDE.md`
  and `RULES.md` describe the service and its constraints without naming the logging directory,
  so neither needs an edit.

## Acceptance

- `packages/logging/AppLogger.ts` and `packages/logging/AppLogger.test.ts` exist; git records both
  as renames; `src/platform/` is gone.
- `grep -rn "platform/logging"` over the tracked tree returns nothing.
- `npm test` reports **4 passing, 0 failing** — same count as the baseline.
- `npx tsc --noEmit` is clean (or its skip is recorded with a reason).
- N-1 names the new path.
- RULES.md still holds: no new dependency (Node built-ins only), the test sits in the same
  directory as the module and keeps the name `AppLogger.test.ts`, and the redaction plus
  request-id guarantees are untouched.
