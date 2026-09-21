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

# Plan for T-4: Add per-client rate limiting to the HTTP handler

## Ticket Description

Requests from one client can starve the others. Add per-client rate limiting to the HTTP handler: a fixed window per client id (the x-client-id header), a 429 response when the window is exhausted, and a test.


Write an implementation plan for this ticket. Save it to `.story/sessions/b5a59916-3066-4c27-a5be-c41f08466ad9/plan.md`.

When done, call `storybloq_autonomous_guide` with:
```json
{ "sessionId": "b5a59916-3066-4c27-a5be-c41f08466ad9", "action": "report", "report": { "completedAction": "plan_written" } }
```
---
**Session:** b5a59916-3066-4c27-a5be-c41f08466ad9
**State:** PLAN (from PICK_TICKET)
**Ticket:** T-4: Add per-client rate limiting to the HTTP handler
**Risk:** low
**Completed:** none
**Tickets done:** 0
**Branch:** main

**Reminders:**
- Write the plan as a markdown file -- do NOT use client-native plan mode.
- Do NOT ask the user for approval.
- NEVER cancel this session due to context size. Client compaction hooks preserve Storybloq state when compaction occurs; threshold pressure rotates through HANDOVER at a clean boundary.
