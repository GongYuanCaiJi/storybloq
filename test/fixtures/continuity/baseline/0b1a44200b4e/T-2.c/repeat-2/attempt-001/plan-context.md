# context-digest.md

## Recent Handovers

# Handover: T-1 AppLogger landed (2026-09-15)

## Completed
- T-1: AppLogger at src/platform/logging/AppLogger.ts with three tests (redaction by key and by shape at any depth; request id on every line). The router logs through it under the incoming request id. Cites ruling r-eftp2zdb6as643np.

## Decisions
- One logger for the whole service; the ruling is r-eftp2zdb6as643np (it superseded the shorter 09-10 wording).

## Continuation
- T-2 Add logging for background jobs is next. JobQueue already records the enqueuing request id on each job; nothing logs during run() yet.

## Carried forward
- T-3 Move AppLogger into packages/logging once a second service needs it.


---

## Development Rules

# Rules

1. Every emitted log line carries the request id of the work it belongs to, and secrets never reach a log line unredacted.
2. Keep the code dependency-free: Node built-ins only.
3. A change to behaviour comes with a test under the same directory, named `<Module>.test.ts`.


# PLAN instruction (verbatim guide result)

# Plan for T-2: Make failed background jobs traceable to the originating request

## Ticket Description

When a background job fails there is no way to tell which incoming request caused it. Make failed background jobs traceable to the originating request.


Write an implementation plan for this ticket. Save it to `.story/sessions/082344e8-79c8-4915-a651-1658a26b5ac6/plan.md`.

When done, call `storybloq_autonomous_guide` with:
```json
{ "sessionId": "082344e8-79c8-4915-a651-1658a26b5ac6", "action": "report", "report": { "completedAction": "plan_written" } }
```
---
**Session:** 082344e8-79c8-4915-a651-1658a26b5ac6
**State:** PLAN (from PICK_TICKET)
**Ticket:** T-2: Make failed background jobs traceable to the originating request
**Risk:** low
**Completed:** none
**Tickets done:** 0
**Branch:** main

**Reminders:**
- Write the plan as a markdown file -- do NOT use client-native plan mode.
- Do NOT ask the user for approval.
- NEVER cancel this session due to context size. Client compaction hooks preserve Storybloq state when compaction occurs; threshold pressure rotates through HANDOVER at a clean boundary.
