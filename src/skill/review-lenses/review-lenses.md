<!--
  MAINTENANCE: Prompts exist in .ts (autonomous guide) and .md (manual fallback).
  The .ts files are the source of truth. The .md files are agent-readable copies.
  When updating a prompt, update the .ts file first, then sync the .md file.
-->

# Multi-Lens Review -- Evaluation Protocol

This file is referenced from SKILL.md for `/story review-lenses` and when reviewing plans or code.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you.

## When to Use

- After writing a plan (any mode -- /story plan, native plan mode, manual)
- Before committing code (after implementation, before merge)
- When explicitly invoked via `/story review-lenses`

The autonomous guide invokes lenses automatically during CODE_REVIEW/PLAN_REVIEW stages when `reviewBackends` includes `"lenses"`. This protocol is for manual/standalone use.

## When to Combine with Single-Agent Review

Lenses excel at **breadth and static analysis** -- catching duplicated code, missing validation, unused imports, schema gaps, test coverage holes. For **complex state machines, session lifecycles, or multi-file behavioral reasoning** (e.g., "what happens when session resumes after compaction?"), also run a focused single-agent review.

Best workflow: single agent for deep reasoning first, then lenses for breadth/defense-in-depth. The combination is more effective than either alone.

---

## Path A: MCP Available (Primary)

Use this path when `storybloq_review_lenses_prepare` is available as an MCP tool.

### Step 1: Determine review stage

- If reviewing a **plan** (plan text, implementation design, architecture doc): stage = `PLAN_REVIEW`
- If reviewing **code** (uncommitted diff, PR, implementation): stage = `CODE_REVIEW`

### Step 2: Capture the artifact

- **CODE_REVIEW:** Run `git diff` to capture the current diff. Run `git diff --name-only` for changed file list.
  - **Round 2+:** Use `git diff <commit-at-last-review>..HEAD` to capture only changes since the last review.
- **PLAN_REVIEW:** Read the plan file (from `.story/sessions/<id>/plan.md` or the current plan in context).

### Step 3: Prepare the review

Call `storybloq_review_lenses_prepare` with:
```json
{
  "stage": "CODE_REVIEW",
  "diff": "<full diff text>",
  "changedFiles": ["src/foo.ts", "src/bar.ts"],
  "ticketDescription": "T-XXX: description of the ticket (or 'Manual review -- brief description' if no ticket)",
  "reviewRound": 1,
  "priorDeferrals": []
}
```

For rounds 2+, increment `reviewRound` and pass issueKeys of findings you intentionally deferred:
```json
{
  "reviewRound": 2,
  "priorDeferrals": ["clean-code:src/foo.ts:42:dead-param", "test-quality:::handleStart-untested"]
}
```

The tool returns `lensPrompts` (one per active lens) and `metadata`.

### Step 4: Spawn lens agents in parallel

For each lens prompt where `cached: false`, launch a subagent in a **single message with multiple Agent tool calls**:
- **Prompt:** Use the `prompt` string returned by the prepare tool **as-is**. It already contains the full lens instructions with the review artifact (diff or plan) embedded at the end, with secrets redacted. Do NOT append the artifact again -- that duplicates the diff inside the dispatched prompt and re-introduces unredacted content (the separate top-level `artifact` field is the raw, un-redacted input, returned only for reference, not for re-appending).
- **If `promptTruncated: true`:** The assembled prompt exceeded the size cap, so `prompt` is empty (rare -- the cap is large). Do NOT reconstruct it from `promptRef`: prepare does not return the resolved preamble variables, so a reconstruction would not match what prepare built. Instead reduce the review scope (review fewer files, or split the diff across smaller `prepare` calls) and re-run, or surface it as an error -- do not dispatch a blank prompt.
- **Model:** The `model` string returned (sonnet or opus)
- **Tools:** Read, Grep, Glob (read-only)

Skip lenses where `cached: true` -- their findings are already available in `cachedFindings`. You will include them in Step 6.

### Step 5: Collect results

Each lens returns JSON: `{ "status": "complete" | "insufficient-context", "findings": [...] }`

Combine with cached findings from Step 3. For cached lenses, create a result entry: `{ "lens": "<name>", "status": "complete", "findings": <cachedFindings from Step 3> }`. Include ALL active lenses in the results array -- both spawned and cached -- otherwise the synthesize tool will mark missing lenses as "failed."

### Step 6: Synthesize

Call `storybloq_review_lenses_synthesize` with:
```json
{
  "lensResults": [
    { "lens": "clean-code", "status": "complete", "findings": [...] },
    { "lens": "security", "status": "complete", "findings": [...] }
  ],
  "activeLenses": ["clean-code", "security", "error-handling"],
  "skippedLenses": ["performance", "api-design", "concurrency", "test-quality", "accessibility"],
  "reviewRound": 1,
  "reviewId": "lens-xxx"
}
```

The tool validates findings, applies blocking policy, and returns `mergerPrompt`.

### Step 7: Run merger

Spawn one agent with the returned `mergerPrompt`. It deduplicates findings and identifies tensions. The merger returns JSON with `findings`, `tensions`, and `mergeLog`.

### Step 8: Run judge

Call `storybloq_review_lenses_judge` with:
```json
{
  "mergerResultRaw": "<raw JSON from merger agent>",
  "sourceFindings": "<validatedFindings array from the synthesize step>",
  "lensesCompleted": ["clean-code", "security", "error-handling"],
  "lensesFailed": [],
  "lensesInsufficientContext": [],
  "lensesSkipped": ["performance", "api-design", "concurrency", "test-quality", "accessibility"],
  "convergenceHistory": [
    { "round": 1, "verdict": "revise", "blocking": 3, "important": 7, "newCode": "--" }
  ]
}
```

Pass `validatedFindings` from the synthesize step as `sourceFindings`. The tool uses it to restore validator-owned evidence markers the merger LLM may have dropped (CDX-13).

The tool returns `judgePrompt` with verdict calibration rules and convergence guidance.

### Step 9: Run judge agent

Spawn one agent with the `judgePrompt`. It calibrates severity and generates the final verdict. The judge returns the `SynthesisResult` JSON.

### Step 10: Present output

Format the judge's output using the **Standardized Output Format** below.

**Narrate high-severity findings live.** Before (or alongside) the standardized output, surface every `critical` and `major` finding as a one-line agent-visible narration so the user sees lenses earning their keep in real time, not tomorrow in a handover. Format:

```
-> storybloq · <lens>-lens · <severity> · <file>:<line> · <one-line summary>
```

Examples:
- `-> storybloq · security-lens · critical · auth.ts:47 · hardcoded API key in fallback path`
- `-> storybloq · performance-lens · major · feed.tsx:120 · O(n^2) render in message list`
- `-> storybloq · test-quality-lens · major · user.service.ts:89 · happy-path only, missing error cases`

Show these narrations during the autonomous CODE_REVIEW stage too -- this is the differentiating moment for storybloq (multi-AI review catching things single-AI misses) and it's wasted if the findings only surface after the commit lands. Lower-severity findings (`minor`, `info`) roll up into the standardized output; don't narrate those individually.

---

## Path B: MCP Unavailable (Fallback)

Use this path when MCP tools are not available (e.g., plugin-only install, other AI tools).

### Step 1-2: Same as Path A

Determine stage and capture artifact.

### Step 3: Determine active lenses

**Core (always):** clean-code, security, error-handling

**Surface-activated by changed files:**
- ORM imports (prisma, sequelize, typeorm, mongoose, knex), nested loops >= 2, files > 300 lines, hotPaths config -> **performance**
- `**/api/**`, route handlers, controllers, GraphQL resolvers -> **api-design**
- `.swift`, `.go`, `.rs`, async/await + shared state mutation -> **concurrency**
- `*.test.*`, `*.spec.*`, `__tests__/` -> **test-quality**
- `*.tsx`, `*.jsx`, `*.html`, `*.vue`, `*.svelte` -> **accessibility**

**Exclude:** lock files, node_modules, generated code (`*.generated.*`), migrations, binaries, vendored deps.

### Step 4: Read prompt files

Read `references/shared-preamble.md` in this directory. For each active lens, read `references/lens-<name>.md`. Select the **Code Review Prompt** or **Plan Review Prompt** section based on stage.

### Step 5: Fill variables and spawn

Fill `{{variable}}` placeholders in the shared preamble:
- **Required:** `{{lensName}}`, `{{lensVersion}}` (from frontmatter), `{{reviewStage}}`, `{{reviewArtifact}}`, `{{fileManifest}}`, `{{ticketDescription}}`
- **Defaults:** `{{projectRules}}` (empty if no RULES.md), `{{knownFalsePositives}}` (empty), `{{activationReason}}` ("core lens" or file signal), `{{findingBudget}}` (10), `{{confidenceFloor}}` (0.6), `{{artifactType}}` ("diff" or "plan")
- **Lens-specific:** `{{hotPaths}}` (performance only), `{{scannerFindings}}` (security only)
- **Ticket description:** If you have a ticket context (from `/story`, ticket in progress), use it. Otherwise: `"Manual review -- [brief description]"`

Each lens prompt ends with `Append: ## Diff to review\n\n{{reviewArtifact}}` (or `## Plan to review`). This means: when building the final prompt, append the artifact (diff or plan text) at the end after the lens instructions. Replace `{{reviewArtifact}}` with the actual content.

Spawn all lens agents in parallel. Each gets: filled preamble + lens prompt section + artifact. Model from frontmatter (sonnet or opus).

### Step 6-9: Simplified synthesis

Read `references/merger.md` and `references/judge.md`. Run merger then judge as in Path A. Since the MCP synthesize/judge tools aren't available, use these blocking rules when reading the judge output:
- Critical severity + confidence >= 0.8 = blocking
- Everything else = non-blocking
- "Blocking" requires a concrete failure scenario (crash, data corruption) -- not "missing test"

### Step 10: Present output using standardized format below.

### Shortcut for small reviews

If only 1-2 lenses activate and total findings < 5, skip the merger/judge and present findings directly. The synthesis pipeline adds value with 3+ lenses producing overlapping findings.

---

## Error Handling

- **Lens returns malformed output:** Drop it, note the lens in "lensesFailed"
- **Merger fails:** Pass raw (unmerged) findings to the judge
- **Judge fails:** Compute verdict deterministically: any blocking + high-confidence finding = revise, else approve
- **Core lens fails (security, error-handling, clean-code):** Never approve -- maximum verdict is "revise"

---

## Acknowledged Deferrals

After each round, classify findings you received:
- **"I'll fix this"** -> fixed (verify next round)
- **"Out of scope / architectural"** -> deferred (pass issueKey to `priorDeferrals` next round, file as issue)
- **"I disagree"** -> contested (pass to `priorDeferrals`, adds to knownFalsePositives)

This prevents the same findings from being re-reported across rounds.

---

## Standardized Output Format

Every lens review produces this structure, regardless of invocation path:

```markdown
## Multi-Lens Review

**Verdict: APPROVE | REVISE | REJECT**
_One sentence explaining what drove the verdict._

**Lenses:** clean-code, security, error-handling, concurrency, test-quality (5 ran, 3 skipped)
**Round:** R3 | **Recommend next round:** No -- blocking at 0 for 2 rounds, important stable

### Blocking Findings

1. **[severity] description** (lens, confidence, scope: inline/pr/architectural)
   File: `path/to/file.ts:42` | Origin: introduced
   Evidence: `code snippet`
   Fix: actionable recommendation

### Non-Blocking Findings

| # | Severity | Lens | File | Finding | Confidence | Scope | Origin |
|---|----------|------|------|---------|------------|-------|--------|
| 3 | minor | clean-code | src/foo.ts:15 | Function exceeds 80 lines | 0.92 | inline | introduced |

### Pre-Existing Issues Discovered

_Found in surrounding code, not introduced by this diff. Filed as issues, excluded from verdict._

| # | Severity | File | Finding | Filed As |
|---|----------|------|---------|----------|
| P1 | high | src/stages/plan.ts:42 | Unguarded loadProject | ISS-089 |

### Tensions

| Lens A | Lens B | File | Tradeoff |
|--------|--------|------|----------|
| security | performance | src/api.ts:42 | Security wants validation; performance flags overhead |

### Convergence

| Round | Verdict | Blocking | Important | New Code |
|-------|---------|----------|-----------|----------|
| R1 | revise | 5 | 9 | -- |
| R2 | approve | 0 | 3 | 1 file, 12 lines |

### Cleared

- Path traversal: safe (IDs matched against in-memory state)
- Session hijacking: safe (targetWork only on start action)

### JSON Summary

{ "verdict": "approve", "recommendNextRound": false, "blocking": 0, "nonBlocking": 3, "preExisting": 1, "findings": [...] }
```

### Verdict Rules

- **APPROVE** -- No blocking findings, OR all findings are non-blocking. "Approve with findings" is valid. Do NOT use REVISE just because findings exist.
- **REVISE** -- At least one finding has `blocking: true` after calibration. These must be addressed before merge.
- **REJECT** -- Critical blocking finding with high confidence, or fundamental design flaw requiring replanning.
- **"Blocking" requires a concrete failure scenario** -- "crashes the session" is blocking. "Missing test" is NOT blocking. "Missing ?? [] guard" is NOT blocking if Zod defaults protect it.
- **Pre-existing findings** (`origin: "pre-existing"`) and **architectural-scope findings** are excluded from the verdict. File them as issues.
