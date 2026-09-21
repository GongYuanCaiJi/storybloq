# Plan — T-3: Move AppLogger into packages/logging

## Goal

Move `src/platform/logging/` to `packages/logging/`, keeping the same file names, update
every import that points at the old path, and keep the test suite passing from the new
location. This is a pure relocation: no behaviour change, no API change.

## Rulings

T-3 cites no rulings (`citedRulings: []`). The current logging ruling
`r-eftp2zdb6as643np` ("One logger, AppLogger; nothing else writes log lines. Every line
carries the request id of the work it belongs to, and secrets are redacted before the
line is written.") is not cited by this ticket but is the standing constraint behind the
module being moved. A relocation must not weaken it: `AppLogger` stays the only logger,
its redaction and request-id behaviour is untouched, and all three of its tests move with
it and keep passing. No ruling text is edited by this ticket.

## Current state (verified at HEAD)

- `src/platform/logging/AppLogger.ts` — the logger (`AppLogger`, `redact`,
  `redactMessage`, types `LogLevel`, `LogLine`, `Sink`).
- `src/platform/logging/AppLogger.test.ts` — 3 tests, imports `./AppLogger.ts` (relative
  sibling, unaffected by the move).
- `src/platform/logging/` is the only thing under `src/platform/`; that directory becomes
  empty and goes away.
- Baseline `npm test`: 4 tests, 4 pass (3 from AppLogger.test.ts, 1 from router.test.ts).

Every reference to the old path in code (`grep -rn "platform/logging" --include="*.ts"`),
exactly three, all importing from `src/http/`:

| File | Line | Import |
|---|---|---|
| `src/http/router.ts` | 6 | `import { AppLogger, type Sink } from "../platform/logging/AppLogger.ts";` |
| `src/http/handler.ts` | 8 | `import type { Sink } from "../platform/logging/AppLogger.ts";` |
| `src/http/router.test.ts` | 4 | `import type { LogLine } from "../platform/logging/AppLogger.ts";` |

All three become `../../packages/logging/AppLogger.ts` (from `src/http/`, up to `src/`,
up to the repo root, then down into `packages/`).

## Scope decisions

1. **No `package.json` in `packages/logging/`, no workspaces.** The ticket asks for a
   move with "same file names". This repo is a single private package with no build step
   (Node 22 type stripping) and no workspace configuration; relative imports resolve fine
   across the new boundary. Adding package manifest/workspace plumbing would be inventing
   a packaging scheme the ticket did not ask for, and the second service that motivates
   this move does not exist in this repo yet. The directory move is what makes that later
   extraction cheap. Flagged here as an explicit assumption.
2. **`tsconfig.json` needs no change.** Its `include` is already `["src", "packages"]`, so
   the new location is type-checked exactly as the old one was.
3. **`package.json` needs no change.** `npm test` is bare `node --test`, which discovers
   `*.test.ts` recursively from the repo root — that is how it already finds the deeply
   nested `src/platform/logging/AppLogger.test.ts` today, and it will find
   `packages/logging/AppLogger.test.ts` the same way. Verified by the post-move test run
   asserting 4 tests still execute, not just that nothing fails (a suite that silently
   discovered 1 test would also report zero failures).
4. **`git mv`, not copy-and-delete**, so the move is recorded as a rename and file history
   survives.
5. **Note N-1 is updated.** It states "It lives at `src/platform/logging/AppLogger.ts`
   with `AppLogger.test.ts` beside it" — that sentence becomes false the moment this lands,
   and N-1 is the architecture note a future session reads to find the logger. Only the
   location sentence changes; the contract and the ruling reference stay as they are.
   Out of scope and deliberately left alone: the T-1 ticket description and the
   2026-09-15 handover, which are historical records of where the logger was when that
   work landed (handovers are append-only), and the `p1` roadmap phase description, which
   says "Shared platform pieces" as a theme and names no path.

## Steps

1. `mkdir -p packages` and `git mv src/platform/logging packages/logging`. Confirm
   `src/platform/` is left empty and removed.
2. Rewrite the import specifier in the three files in the table above from
   `../platform/logging/AppLogger.ts` to `../../packages/logging/AppLogger.ts`. Nothing
   else in those files changes — same symbols, same `type`-only modifiers (`verbatimModuleSyntax`
   is on, so the `type` keywords must be preserved exactly).
3. `grep -rn "platform/logging" --include="*.ts" .` returns nothing under `src/` or
   `packages/`.
4. `npm test` — expect **4 tests, 4 pass**, the same count and the same test names as the
   baseline.
5. Verify the two **type-only** imports by path, not by test run. Only
   `src/http/router.ts` imports a value (`AppLogger`); `src/http/handler.ts`
   (`import type { Sink }`) and `src/http/router.test.ts` (`import type { LogLine }`) are
   erased by Node's type stripping, so a wrong specifier in either one would leave
   `npm test` green. For each of those two, resolve the written specifier against the file's
   own directory and confirm the target exists (`test -f src/http/../../packages/logging/AppLogger.ts`),
   and confirm the named symbol is exported from it. Then `npx tsc --noEmit` if a TypeScript
   compiler is resolvable offline; if it is not (no dependencies are installed and the repo
   is dependency-free by RULES.md rule 2), skip it and say so rather than claiming a type
   check that did not run.
6. Update N-1's location sentence via `storybloq_note_update`.

## Acceptance criteria

- `packages/logging/AppLogger.ts` and `packages/logging/AppLogger.test.ts` exist with
  byte-identical content to the originals; `src/platform/` no longer exists.
- Git records the two files as renames.
- No file under `src/` or `packages/` mentions `platform/logging`.
- `npm test` reports 4 tests passing — the same three AppLogger tests and the router test.
- No change to `AppLogger`'s behaviour, exported API, redaction rules, or request-id
  handling; no new dependency (RULES.md rule 2).

## Risks

- **Wrong relative depth** in the rewritten imports (`../` vs `../../`). For
  `src/http/router.ts` this is caught immediately by step 4 — it imports the `AppLogger`
  value, so a bad specifier fails at import time before any assertion runs. For the two
  `import type` specifiers it is **not**: type-only imports are erased by Node's type
  stripping, so a wrong path in `handler.ts` or `router.test.ts` leaves the suite green.
  Step 5 resolves those two by path explicitly, which is the only check that covers them
  when no type checker is available.
- **Test discovery silently narrowing** after the move. Caught by asserting the test
  *count* is 4 in step 4, not merely that the run is green.
- **Stale documentation** pointing at the old path. Addressed for N-1 in step 6; the
  historical records named in scope decision 5 are intentionally left as-is.
