<!-- 2026-09-20-01-auto-session.md -->
# Handover: T-3 AppLogger moved to packages/logging (2026-09-20)

Targeted autonomous session, one item: `/story auto T-3`. Commit `954f430` on `main`.

## Completed

- **T-3: Move AppLogger into packages/logging** -- complete. `src/platform/logging/` moved to
  `packages/logging/` with the same file names. Both files are byte-identical to their previous
  versions (verified by sha256 against `cc31f85`; git records both as 100% renames), so nothing
  about redaction or request-id behaviour changed. The three importers in `src/http/`
  (`router.ts`, `handler.ts`, `router.test.ts`) now point at `../../packages/logging/AppLogger.ts`.
  `src/platform/` is gone from disk and from the index. `npm test` still runs 4 tests, 4 passing,
  with the three AppLogger tests executing from the new location.
- No config change was needed: root `tsconfig.json` already had `"include": ["src", "packages"]`,
  and `package.json`'s bare `node --test` discovers `packages/**/*.test.ts` on Node 22.18 (confirmed
  by the passing run, not assumed).

## Decisions

- **T-3 now cites ruling r-eftp2zdb6as643np** (current; supersedes r-rvcf99q7dwhzzpav). It did not
  cite it at the start of the session. The citation was added so any agent reviewing a change to the
  logger receives the one-logger/redaction/request-id ruling through the ledger rather than by paste.
- **No re-export shim at the old path.** A shim would leave two live paths to the one logger, which
  cuts against the ruling's "one logger" framing. The ticket asked for the imports to be updated, and
  they were.
- **No manifest for `packages/logging`** -- see ISS-001 below. Out of scope for T-3 by the approved
  plan; the repo has no workspaces today.
- **Note N-1 was updated, the T-1 handover was not.** N-1 ("AppLogger: where it lives and what it
  guarantees") is the durable location-of-record a future session reads to find the logger, so its
  location sentence now says `packages/logging/AppLogger.ts`; its contract and ruling paragraphs are
  untouched. `.story/handovers/2026-09-15-t-1-applogger.md` still names the old path and is
  deliberately left alone: handovers are append-only historical records of what was true on their
  date.

## Stale references to the old path (known, deliberate)

`grep -rn "platform/logging" . --exclude-dir=.git` returns three hits, all prose in `.story/`, none
of them code:

1. `.story/handovers/2026-09-15-t-1-applogger.md:4` -- dated record, append-only, left as-is. This
   is the one that matters most to a new session, because `storybloq_handover_latest` serves it. Its
   own "Carried forward" line names T-3, so a reader who also sees T-3 complete can reconcile it --
   and this handover is now the newer record.
2. `.story/tickets/T-1.json:4` -- a COMPLETE ticket's description, recording where the logger landed
   when T-1 shipped. Rewriting it would falsify the record.
3. `.story/tickets/T-3.json:14` -- this ticket's own description, which correctly names the source
   and destination of the move.

Worth flagging honestly: my implementation report initially claimed two hits, because the grep I ran
carried an `--exclude-dir=handovers` the disclosure did not mention. The code review caught it and I
re-ran it clean. The number above is the verified one.

## Filed

- **ISS-001** (medium): `packages/logging` has no manifest, so a second service still cannot consume
  it. The move satisfies T-3 as written, but not the motivation behind it -- there is no
  `package.json` and no workspace config, and the importers reach the package by deep relative path
  (`../../packages/logging/AppLogger.ts`), which does not port to another service or repo. Needs a
  manifest and/or workspace entry, plus a decision on the specifier consumers should use, before the
  second service lands.

## Continuation

- **ISS-001** is the natural next item: it is the remaining gap between "the logger moved" and "the
  logger is shareable", and it blocks nothing until the second service is real.
- T-4 (if it touches `src/http/handler.ts`) should be aware the logger's `Sink`/`LogLine` types now
  come from `../../packages/logging/AppLogger.ts`.

## Review notes for the next session

The Codex review bridge is NOT available on this client -- no `review_plan` or equivalent tool is
registered, and tool discovery for it returns nothing. Both the plan review and the code review in
this session ran through the agent fallback. `storybloq_health` with `only: ["codex-bridge"]` is
worth running if a future session expects codex review.

The MCP server also reported a version skew at session start: server v1.15.9 vs v0.0.1 installed,
with a suggestion to restart the client. It did not affect this session.
