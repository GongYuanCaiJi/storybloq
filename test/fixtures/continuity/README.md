# Continuity fixture (T-525)

The release gate for 1.16.0 asks one question: does a fresh session find the existing implementation and the applicable decision, respect them or justify a change, and leave the map accurate? This directory is the project that question is asked on, the rubric it is scored with, and the recorded baseline it is compared against.

## Layout

```
core/                 the project every arm runs: a small Node service (AppLogger, router, handler, JobQueue)
                      with its own .story/ (rulings R1 R2 R3 R5, notes N-1 N-2, tickets T-1..T-4, one handover)
overlays/arm3/        catalogs (.story/capabilities.json, .story/glossary.json); lands with T-523 and T-524
overlays/lifecycle/   R4, a PROPOSED ruling against R1, for the deterministic suite only; lands with T-522
variants/             T-2 as three {title, description} overrides: (a) names src/jobs/, (b) names no path,
                      (c) no "logging" keyword ("Make failed background jobs traceable to the originating request")
facts.json            every behavioural fact and the file that carries it per arm (P-1 equivalence)
fixture-map.json      label -> id for rulings, tickets, notes
rubric.md             the frozen scoring rubric (rubricVersion 1)
baseline/             the recorded arm-1 baseline (sanitised artefacts; raw transcripts live in the private
                      workspace at eval-runs/continuity/)
```

The core has no nested `.git`; the runner and the suite initialise a temporary repository per run.

## Arms (F-A)

| Arm | Workflow | Ledger |
|---|---|---|
| 1 | storybloq 1.15.9, before any 1.16.0 change (the baseline) | core |
| 2 | revised workflow, ordinary notes and rulings only | core |
| 3 | revised workflow with the catalogs | core + overlays/arm3 |

Every fact exists in every arm (`facts.json`); arm 3 adds structure, never facts. R4 is not part of any behavioural arm.

## Running

Fresh isolation (the intended mode; the owner mints the token with `claude setup-token`):

```
export CLAUDE_CODE_OAUTH_TOKEN=...
npx tsx scripts/continuity-run.ts --arm 1 --isolation fresh --model claude-opus-5 --effort high \
  --out test/fixtures/continuity/baseline --raw-out ../eval-runs/continuity
```

Shared isolation runs against the live `~/.claude` and can only qualify with an owner exception recorded as a
ruling in the workspace ledger that names T-525 and the word "shared"; pass its id with
`--owner-exception r-...`. Tasks and repeats default to the whole preregistered matrix (5 tasks x 3). `--tasks` and `--repeats` select a
smaller LIVE run that still launches real sessions and incurs model usage; a proper subset of the matrix never
qualifies.

Scoring is three steps, because the scorer is Codex reached through the pen's bridge session, not by a script:

```
npx tsx scripts/continuity-score.ts prepare <expDir>                 # scoring-request.rubric<v>.md per valid attempt; behavioural failures are scored mechanically
npx tsx scripts/continuity-score.ts record  <attemptDir> '<json>'    # one Codex verdict, validated and publication-checked, never overwriting
npx tsx scripts/continuity-score.ts report  <expDir>                 # results-<date>-<cli>-rubric<v>.md over the preregistered cells
```

Preflight refuses to start when: an alternate-auth env var is set; the input tree (`src/`, `plugins/`, `scripts/`, package files, this fixture) has uncommitted changes; `vitest` or `jest` is running; the installed skill differs from `src/skill/` by more than the `.storybloq-version` marker (shared mode); `CLAUDE_CODE_OAUTH_TOKEN` is absent (fresh mode). It then builds `dist/` itself and records the hashes.

An attempt is `invalid` (kept, listed, never scored) when the server fingerprint recorded in the session does not match the built `dist/mcp.js`, when the ISS-906 stale-server sentence appears, when the main-session model is not the pinned one, when the build or the effective configuration changed under the run, or when the session was interrupted by the runner. A valid attempt that did not complete its ticket is a behavioural failure: it counts, and it fails every criterion.

The experiment QUALIFIES when each of the 15 cells (5 tasks x 3 repeats) has one valid observation; only then is `QUALIFYING` written and the results file citable as the release baseline. A `shared`-isolation experiment qualifies only with a recorded owner exception id.

## Publication rule

Everything under `storybloq/` is projected to the public repository. Only sanitised artefacts (plans, diffs, ledger changes, evidence with paths and identities substituted, scores, manifests) are written here; raw transcripts, stderr and ledger snapshots go to `--raw-out`. The sanitiser refuses to write an artefact that still carries a credential-looking string, except the exact synthetic examples the fixture itself contains (listed per attempt in `redaction.json` as fixture-derived).

## Ledger version log

- v0 (2026-09-20): core as above. No proposal record, no catalogs.
