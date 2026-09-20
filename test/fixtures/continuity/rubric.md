# Continuity evaluation rubric

rubricVersion: 1
frozen: 2026-09-20 (before any 1.16.0 implementation landed; T-525 P-4)
scorer: Codex through codex-claude-bridge `review_plan`, tier max; the observed model is recorded on every score
method: scripted headless `claude -p` sessions (T-525 scope item 4 fallback; `claude plugin eval` was not used because it mocks MCP by default, sandboxes shell tools and grades with its own graders, while a `/story auto` session needs the real server, git and `npm test`, and P-5 needs the raw event stream)

A change to any PASS definition, checkpoint, evidence rule or aggregation rule below is a new `rubricVersion`. Every arm is rescored together under the new version and both scorings are kept.

## Tasks

| Task | Title (as materialised) | What the correct session does |
|---|---|---|
| T-2.a | Add logging for background jobs (names `src/jobs/`) | Finds AppLogger, cites R1 and R2, logs jobs through AppLogger under the enqueuing request id, tests it |
| T-2.b | Add logging for background jobs (names no path) | Same as T-2.a without a path hint |
| T-2.c | Make failed background jobs traceable to the originating request | Same as T-2.a without the word "logging" in the task |
| T-3 | Move AppLogger into packages/logging | Moves the module, keeps the contract and tests, reports that N-1's path (and, in arm 3, cap-logging's entry point) is stale |
| T-4 | Add per-client rate limiting to the HTTP handler | Inspects `src/http/`, finds no limiter, says so, builds one; any log line it emits goes through AppLogger under the request id |

Labels R1, R2, R3, N-1, N-2 resolve through `fixture-map.json`.

## Checkpoints (frozen)

- INITIAL: `plan.initial.md` (the plan at the first `plan_written` report) plus every main-session tool call made before that report. Measures what discovery delivered before any reviewer repaired it.
- FINAL: `plan.md` (the reviewed plan), `source.diff`, `ledger.changes.json`, the handover(s), every guide `report` payload. Measures what shipped.

Each criterion is scored at BOTH checkpoints and both columns are reported. The arm comparison uses: C1 and C2 at INITIAL; C3 and C4 at FINAL; C5 at FINAL.

## Criteria

### C1. Found the existing implementation
Evidence: tool calls (file reads) and the plan text.
- T-2.*, T-3: PASS when the plan names `src/platform/logging/AppLogger.ts` (or its moved location) AND a read of that file itself appears in the tool calls before the checkpoint AND the plan uses what it read (names `withRequestId` or `redact` or the sink, not just the path). A read of N-1 is discovery evidence only: it can explain how the path was found, it never substitutes for reading the implementation. Example: a session that reads N-1, names the path and both API names from the note, and never opens AppLogger.ts FAILS C1.
- T-4: PASS when the plan states, after a read of `src/http/`, that no rate limiter exists in the project. FAIL when it asserts an existing limiter or names a capability that does not exist.
Does not count: mentioning the path without reading it; reading it without using it.

### C2. Cited the applicable ruling through the citation mechanism
Evidence: `ledger.changes.json` (the `citesRulings` field of the task ticket), the plan text, guide instructions.
- T-2.*: PASS when R1 AND R2 are added to T-2's `citesRulings` (a `ticket update`, visible in the ledger changes) and the plan names their current ids. R2 is the uncited-but-applicable one; a plan that names R1 only is a partial FAIL recorded as `r2-missed`.
- T-3: PASS when R1 is cited on T-3.
- T-4: PASS when no ruling is cited as governing rate limiting AND the plan states that the logging rulings bind any log line the limiter emits (calibrated: AppLogger for the limiter's lines is legitimate shared context). FAIL when a ruling is cited as if it governed rate limiting.
Does not count: the ruling text pasted into the plan without the citation; the id mentioned in prose only.

### C3. Proposed reuse or a justified replacement that preserves the guarantees
Evidence: `plan.md`, `source.diff`.
- T-2.*: PASS when jobs log through AppLogger bound to the enqueuing request id, OR a replacement logger is introduced WITH the reason stated AND redaction and request id preserved. FAIL on a second logging path (console.log, a new library) without redaction or request id.
- T-3: PASS when the moved module keeps `redact`, `withRequestId` and the sink contract, and every import is updated.
- T-4: PASS when the plan does not fabricate an existing limiter, states the inspection result, and the limiter's log lines (if any) go through AppLogger.

### C4. Specified tests for the guarantees
Evidence: `plan.md`, `source.diff` (test files).
- T-2.*: PASS when a test asserts a job's log line carries the enqueuing request id AND a test (new or existing) covers redaction on that path.
- T-3: PASS when the AppLogger tests (all three) run from the new location (`node --test` discovers them) and pass.
- T-4: PASS when a test covers the 429 path; if the limiter logs, a test covers the request id on its line.

### C5. Reported the knowledge impact correctly at completion
Evidence: handover(s), commit message, guide `report` payloads, `ledger.changes.json`; in arm 3 also `capabilities.json` after the run.
The correct report accounts for EVERY knowledge record present in the arm that the change touches.
- T-2.*: the minimal correct outcome is that no existing record changes and the report says so, naming what is new (jobs now log). An accurate maintenance edit also passes: if the session updated N-1 to document the job-logging coverage and the report names that update, PASS. The report is compared against `ledger.changes.json`: FAIL when it claims a change that did not happen, when a record did change and the report leaves it unnamed, or when a ruling's text was edited.
- T-3: N-1's path is STALE in every arm; in arm 3 `cap-logging`'s entry point is stale too. PASS when the report names each stale record and either proposes the update or updates it correctly under the workflow's contract. A run that edits R1's text fails. A run that leaves a stale record unmentioned fails, whatever it said about the others.
- T-4: no existing record changes; PASS when the report names the new fact (limiter location).
Does not count: a `knowledgeImpact` field with no content; silence.

## Recorded metrics (not scored)

retrieval failures (tool results with ENOENT or "No such file" on a path under the working copy); irrelevant context delivered (R3's id or text, or N-2 for T-2.*/T-3, present in any instruction or tool result the main session received); context at PLAN entry; context before plan written; total input tokens; total cost (USD from the client's `result` event); wall time; turns; main-session model set; review rounds; terminal guide state; completion status.

Token accounting: context for an assistant request = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; requests are deduplicated by `request_id`; only main-session events (`parent_tool_use_id` null) count. PLAN entry = the first main-session request whose preceding `user` event carries the tool result of the guide call whose result has `**State:** PLAN`. Before plan written = the last main-session request before the tool result of the first `plan_written` report. Repeated PLAN entries are all recorded; the first is the headline.

## Aggregation (frozen)

- A cell is one (task, repeat) pair; it is satisfied by one valid observation. Three cells per task.
- A valid behavioural failure (the session did not reach SESSION_END with the ticket completed, or wrote no plan) is an observation that fails every criterion at both checkpoints.
- Per task and criterion: passes over satisfied cells; a task passes a criterion at 2 of 3 or better.
- Missing evidence for a criterion is a FAIL recorded as `missing-evidence`.
- Provenance-invalid attempts are never scored and never counted; they are listed.

## Scorer prompt (verbatim, per attempt)

```
You are scoring one recorded autonomous coding session against a fixed rubric. Read rubric.md first. Then read, in this order: fixture-map.json (label to id), task.json (the ticket exactly as the session saw it, any variant already applied), plan.initial.md, plan.md, evidence.jsonl (every main-session tool call: tool_use_id, name, full input, full result, and whether it came before the first plan_written report), source.diff, ledger.changes.json, handover.md, reports.json. Score every criterion C1..C5 at the INITIAL checkpoint and at the FINAL checkpoint exactly as the rubric defines them for this task. Cite the evidence by tool_use_id, file and line where you can. When a criterion's evidence is absent, mark it fail with reason "missing-evidence". Do not infer intent; score what the record shows. In "scorer", disclose the provider you are and the model that actually ran (as observed at runtime, not as requested). Answer with one JSON block and nothing else:
{"rubricVersion":1,"task":"<task>","initial":{"C1":{"pass":bool,"evidence":"..."},...,"C5":{...}},"final":{"C1":{...},...,"C5":{...}},"flags":["r2-missed"|"missing-evidence"|...],"notes":"...","scorer":{"provider":"codex","observedModel":"<model id observed>","sessionId":"<bridge session id if known>"}}
```
