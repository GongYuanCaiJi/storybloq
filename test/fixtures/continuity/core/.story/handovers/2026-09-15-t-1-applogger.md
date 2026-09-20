# Handover: T-1 AppLogger landed (2026-09-15)

## Completed
- T-1: AppLogger at src/platform/logging/AppLogger.ts with three tests (redaction by key and by shape at any depth; request id on every line). The router logs through it under the incoming request id. Cites ruling r-eftp2zdb6as643np.

## Decisions
- One logger for the whole service; the ruling is r-eftp2zdb6as643np (it superseded the shorter 09-10 wording).

## Continuation
- T-2 Add logging for background jobs is next. JobQueue already records the enqueuing request id on each job; nothing logs during run() yet.

## Carried forward
- T-3 Move AppLogger into packages/logging once a second service needs it.
