# Plan: T-3 -- Move AppLogger into packages/logging

## Goal

Move `src/platform/logging/` to `packages/logging/`, keeping the same file names, update every
import that points at the old location, and keep `npm test` green from the new location.

## Binding rulings

- **r-eftp2zdb6as643np** (current; supersedes r-rvcf99q7dwhzzpav) -- "Logging keeps redaction and
  request ids on every path. One logger, AppLogger; nothing else writes log lines. Every line
  carries the request id of the work it belongs to, and secrets are redacted before the line is
  written."

  This is a pure relocation, so the ruling is satisfied by preserving `AppLogger`'s behaviour
  byte-for-byte: no second logger is introduced, no redaction or request-id code is rewritten, and
  the three existing behaviour tests move with it unchanged. The ruling is not currently cited by
  T-3 in the ledger; the plan adds the citation so reviewers of this move see it.

- RULES.md 2 (Node built-ins only) -- the move adds no dependency and no build step.
- RULES.md 3 (a behaviour change comes with a test named `<Module>.test.ts`) -- this change has no
  behaviour delta, and `AppLogger.test.ts` moves alongside `AppLogger.ts`, keeping the co-location
  the rule asks for.

## Current state (verified at HEAD)

- `src/platform/logging/AppLogger.ts` -- the logger, `redact`, `redactMessage`, `Sink`, `LogLine`,
  `LogLevel`.
- `src/platform/logging/AppLogger.test.ts` -- 3 tests, imports `./AppLogger.ts` (relative, same dir).
- Three importers of the old path, all in `src/http/`, all via `../platform/logging/AppLogger.ts`:
  - `src/http/router.ts:6` -- `import { AppLogger, type Sink }`
  - `src/http/handler.ts:8` -- `import type { Sink }`
  - `src/http/router.test.ts:4` -- `import type { LogLine }`
- `src/jobs/JobQueue.ts` does not import the logger; nothing else references `platform`.
- `tsconfig.json` already has `"include": ["src", "packages"]`, so the new directory is type-checked
  without a config change.
- `package.json` test script is bare `node --test`, which recurses from the repo root and discovers
  `**/*.test.ts` outside `node_modules` -- so the relocated test is picked up with no script change.
- Baseline on Node v22.18.0: `npm test` -> 4 passing, 0 failing.

## Steps

1. `git mv src/platform/logging packages/logging`, so both files move with history preserved and
   their names unchanged. `src/platform/` is then empty and git drops it automatically; verify no
   stray `src/platform` directory remains on disk.
2. Rewrite the three importers from `../platform/logging/AppLogger.ts` to
   `../../packages/logging/AppLogger.ts`. The importing files stay in `src/http/`, so the new path
   climbs out of `src/` and back down into `packages/`. Imported symbols and `type`-only forms are
   unchanged.
3. Leave `packages/logging/AppLogger.test.ts`'s own `./AppLogger.ts` import untouched -- it is
   sibling-relative and the two files move together.
4. Touch no logic in `AppLogger.ts`: no rename, no signature change, no redaction or request-id
   edit. The diff for that file should be a pure rename with zero content lines.

## Verification

- `grep -rn "platform/logging" --include="*.ts" .` returns nothing.
- `git status --porcelain` shows `AppLogger.ts` and `AppLogger.test.ts` as renames (R), not as a
  delete plus an unrelated add, and the three import edits as modifications.
- `npm test` -> still 4 passing, 0 failing, including the three AppLogger tests now running from
  `packages/logging/` and the router test that logs under an assigned request id.
- `npx tsc --noEmit` if a TypeScript binary is resolvable without a network install; otherwise rely
  on the test run, since Node executes the TypeScript directly (type stripping, no build step) and
  a bad specifier fails at import time rather than silently.

## Out of scope

- No re-export shim or barrel file at the old path: the ticket says move and update every import,
  and a shim would leave two live paths to the one logger.
- No package.json/workspace manifest for `packages/logging`. The repo has no workspaces today and
  the ticket does not ask for publishing; the second service consuming it is a later concern.
- No change to what is logged, to `JobQueue`, or to the router/handler beyond the import line.

## Risks

- `node --test` discovery silently skipping the new directory would make the suite look green with
  fewer tests. Mitigated by checking the post-move run still reports exactly 4 tests, not just
  "0 fail".
