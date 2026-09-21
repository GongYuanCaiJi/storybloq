<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-3 AppLogger moved to packages/logging (2026-09-20)

Targeted autonomous session, one item: T-3. Commit `4b43610` on `main`.

## Completed

- **T-3: Move AppLogger into packages/logging** — complete. `src/platform/logging/` is now `packages/logging/`, same two file names. Git records both files as 100% renames, so the logger's content is byte-identical: no change to its API, redaction rules, or request-id handling. `src/platform/` was empty afterwards and is gone.
- Three imports rewritten from `../platform/logging/AppLogger.ts` to `../../packages/logging/AppLogger.ts`: `src/http/router.ts`, `src/http/handler.ts`, `src/http/router.test.ts`. Nothing under `src/` or `packages/` still mentions the old path.
- Note **N-1** updated to point at the new location and to record that there is no package manifest or workspace entry for it yet.

## Verification

- `npm test`: **4 tests, 4 pass** — the same count and the same test names as the pre-move baseline. Asserting the count, not just a green run, is what rules out test discovery silently narrowing after the move.
- **No type check was run.** `npx tsc --noEmit` has no compiler to resolve: the repo is dependency-free by RULES.md rule 2 and nothing is installed. This is stated rather than glossed because of the next point.
- Plan review (codex) caught that only `router.ts` imports a *value*; the specifiers in `handler.ts` and `router.test.ts` are `import type` and are erased by Node's type stripping, so a wrong path in either would leave the suite green. Both were verified by resolving the specifier from the file's own directory and confirming `Sink`/`LogLine` are exported at the target. With no type checker available, that path check is the only thing covering those two imports — worth repeating on any future move that touches type-only imports.
- Code review (codex, full diff): approve, zero findings.

## Decisions

- **No `package.json` in `packages/logging/`, no workspaces.** The ticket asked for a move with the same file names. This repo is a single private package, no build step (Node 22 type stripping), no workspace config, and relative imports resolve across the new boundary unchanged. The second service that motivates the move does not exist in this repo yet; the directory move is what makes that later extraction cheap. **If a second consumer lands, this is the decision to revisit first** — that is the point where a manifest and a real package name start earning their keep, and where the `../../packages/...` relative specifiers should become a package import.
- `tsconfig.json` and `package.json` needed no edit: `include` was already `["src", "packages"]`, and `node --test` discovers `*.test.ts` recursively from the repo root.
- Committed as `refactor:` rather than the guide's suggested `feat:` — the change adds no capability and `feat` would misdescribe it in the history.
- Historical records deliberately left stale: the T-1 ticket description and the 2026-09-15 handover both name `src/platform/logging/`, which is where the logger was when that work landed. Handovers are append-only. The `p1` roadmap description names no path.

## Continuation

- **T-2: Add logging for background jobs** is the next item, and it was already the continuation named in the 2026-09-15 handover. `JobQueue` (`src/jobs/JobQueue.ts`) records the enqueuing request id on each job but `run()` still logs nothing. Ruling **r-p19bbvh0jhj8xgma** binds it directly: a job's log lines carry the request id of the request that enqueued it, not a fresh one — `QueuedJob.requestId` is already there to be used. Ruling **r-eftp2zdb6as643np** applies too: AppLogger is the only thing that writes log lines. Note the import path from `src/jobs/` will be `../../packages/logging/AppLogger.ts`.
- Then T-4 (per-client rate limiting on the HTTP handler).

## Carried forward

- No open issues were filed this session; nothing pre-existing surfaced in either review.
