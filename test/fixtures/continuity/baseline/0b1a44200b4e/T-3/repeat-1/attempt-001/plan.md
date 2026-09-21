# Plan: T-3 — Move AppLogger into packages/logging

## Goal

Move `src/platform/logging/` to `packages/logging/` keeping the same file names, update every
import that points at the old location, and keep the test suite passing from the new location.
This is a pure relocation: no behaviour change, no API change, no new dependency.

## Rulings

T-3 cites no rulings (`.story/tickets/T-3.json` carries no `citedRulings` key; `ticket_get` reports
it as `citedRulings: []`), so the plan-pin gate has nothing to satisfy. The
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
4. **Verify no reference to the old path survives *in code*.** `grep -rn "platform/logging" src packages`
   must return nothing. This is the check that step 3 was complete rather than merely plausible —
   the table is from a grep, but the grep is also how the claim gets confirmed after the edit.

   The scope is `src packages` deliberately, not the whole tracked tree. Three other tracked files
   name the old path and must keep naming it:

   - `.story/tickets/T-1.json:4` — a completed ticket, describing where the logger was put *then*.
   - `.story/handovers/2026-09-15-t-1-applogger.md:4` — a historical handover.
   - `.story/tickets/T-3.json:11` — this ticket's own description, which names the source of the move.

   These are historical records, not current-state claims, and rewriting them to make a grep come
   out green would falsify the ledger. A whole-tree grep would therefore either block the
   implementer or push them into exactly that falsification. Only N-1 (step 7) is updated, because
   N-1 is the one record that asserts where the logger lives *now*.
5. **Run `npm test`.** Expect the same 4 tests passing. Two things are being confirmed at once,
   and it is worth naming the second: that the three rewritten imports resolve, and that
   `node --test` (bare, no path argument, per `package.json`) still *discovers*
   `packages/logging/AppLogger.test.ts` at its new location. Node 22's default discovery walks the
   cwd recursively, so `packages/` should be picked up without a script change — but a test that
   silently stops being discovered looks identical to a test that passes, so assert on the
   **count**: 4, not merely "0 failed". If the count drops, the fix is to make the discovery
   explicit in the `test` script rather than to accept a smaller suite.
6. **Type-check as a baseline diff, not as a clean run.** `tsc --noEmit` (bare — `tsc` 5.9.3
   resolves on PATH; avoid `npx`, which may reach for the network and would drop a `node_modules/`
   into the repo for what is a pure relocation).

   This repo does **not** type-check clean today and this ticket cannot make it do so. On the
   untouched tree `tsc --noEmit` exits 2 with exactly 6 errors, every one of them the absence of
   `@types/node`:

   ```
   src/http/handler.ts(5,28)               TS2307  Cannot find module 'node:crypto'
   src/http/router.test.ts(1,18)           TS2307  Cannot find module 'node:test'
   src/http/router.test.ts(2,20)           TS2307  Cannot find module 'node:assert/strict'
   src/platform/logging/AppLogger.test.ts(1,18)  TS2307  Cannot find module 'node:test'
   src/platform/logging/AppLogger.test.ts(2,20)  TS2307  Cannot find module 'node:assert/strict'
   src/platform/logging/AppLogger.ts(87,3)       TS2580  Cannot find name 'process'
   ```

   So the criterion is a **before/after comparison**: the same 6 errors, with the two
   `src/platform/logging/…` paths now reading `packages/logging/…`, and — the part that carries the
   actual signal — **no new `TS2307` for `'../../packages/logging/AppLogger.ts'`**. That residual is
   what proves the three rewritten specifiers resolve. Demanding a clean run instead would produce a
   guaranteed false failure, whose obvious "fix" (`npm i -D @types/node`) would add a dependency and
   break RULES.md rule 2. Do not install anything to make this step pass.

   What this step still confirms on its own terms: `tsconfig.json` already has
   `include: ["src", "packages"]`, so `packages/logging/` enters the program with no config edit.
   The evidence for that is narrower than it looks, though, and worth stating precisely:
   `packages/logging/AppLogger.ts` would be in the program either way, pulled in through the import
   graph from `src/http/`. It is the **test** file that proves `include` covers `packages/` — nothing
   imports `AppLogger.test.ts`, so its two `TS2307`s can only appear if `include` reaches it.

   *If `tsc` is not on this shell's PATH:* skip this step and record that it was skipped. Step 5
   (`npm test`) already proves the rewritten specifiers resolve, since an unresolvable import fails
   the test run outright. Do **not** install TypeScript or `@types/node` to make step 6 runnable —
   that trades a nice-to-have check for a RULES.md rule 2 violation.
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
- **Stale ledger prose** — four tracked records name the old path, and only one of them is stale.
  N-1 asserts where the logger lives *now*, so the move makes it wrong and step 7 fixes it. T-1.json,
  T-3.json and the 2026-09-15 handover describe where it lived at the time they were written; they
  stay as they are. The risk to guard against here is over-correction, not omission: a
  search-and-replace across `.story/` would rewrite history to match the present, which is the one
  thing an append-only ledger must not do. `CLAUDE.md` and `RULES.md` describe the service and its
  constraints without naming the logging directory, so neither needs an edit.

## Acceptance

- `packages/logging/AppLogger.ts` and `packages/logging/AppLogger.test.ts` exist; git records both
  as renames; `src/platform/` is gone.
- `grep -rn "platform/logging" src packages` returns nothing. The three historical ledger records
  named in step 4 still contain the old path, and that is correct, not a miss.
- `npm test` reports **4 passing, 0 failing** — same count as the baseline.
- `tsc --noEmit` reports the same 6 pre-existing `@types/node` errors as the baseline, with the two
  AppLogger paths relocated to `packages/logging/` and no new `TS2307` for the rewritten
  `../../packages/logging/AppLogger.ts` specifier. It is not expected to exit 0, and nothing is
  installed to make it.
- N-1 names the new path; T-1.json, T-3.json and the 2026-09-15 handover are unmodified.
- RULES.md still holds: no new dependency (Node built-ins only), the test sits in the same
  directory as the module and keeps the name `AppLogger.test.ts`, and the redaction plus
  request-id guarantees are untouched.
