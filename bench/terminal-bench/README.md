# Terminal-Bench 2.0 adapter for the storybloq harness (T-500)

Not part of the npm package (`files` allow-list excludes `bench/`). Runs the Terminal-Bench
2.0 task set (89 tasks, repo `laude-institute/terminal-bench-2`, pinned by commit in the
manifest) through the `harbor` 0.22.0 runner with two custom agents.

## Framing (fixed)

Terminal-Bench scores one sandboxed session per task; nothing carries between tasks.
storybloq's cross-session continuity contributes zero here by construction. What this
measures is the single-session discipline the `/story` skill imposes: plan before code,
proven-RED tests, an independent review round, repair on failure. Results are never
described as "storybloq makes models smarter". Cost per task is reported beside pass rate,
always; cost per PASSED task (total arm spend including failures, divided by passes) is
the decision number.

## Arms

| Arm | Agent | Review backend |
|---|---|---|
| A0 | `agents.baseline:StorybloqBaseline` (harbor's Claude Code agent plus isolation checks) | none |
| A1 | `agents.storybloq_auto:StorybloqAuto --ak arm=A1` | skill's built-in agent reviewer |
| A2 | same, `arm=A2` | Codex via codex-bridge inside the container |
| A3 | same, `arm=A3` | lenses |
| A4 | same, `arm=A4` | Codex + lenses |

Every arm appends the same task-neutral sentence (`agents/instruction.txt`) to the task text,
byte for byte, nothing stripped. Executor model is passed with `-m anthropic/<model>` and the
Claude Code pin with `--ak version=<pin>`; both must equal the frozen manifest or the agent
refuses to construct. Treatment arms create ONE ticket from the task text and run
`/story auto <id>`; only their wrapper mentions the ticket.

## Protocol (frozen by the manifest hash)

Identical across arms: task text, instruction suffix, executor model, no `--max-turns`, no
`--max-budget-usd`, the task's own timeouts at multiplier 1.0, one attempt, no retries except
a single rerun of a PRE-START infra failure. Estimand: equal wall-clock budget per the
task's own timeout; treatment arms may spend more tokens and that spend is what the cost
column reports. Per task the arm order is drawn from the seed; runs are sequential
(`-n 1`), foreground, logs to a file. `regex-log` (from `terminal-bench-sample@2.0`) is the
smoke task and is excluded from the pilot frame. Any change to a hashed file after the
freeze requires a new manifest; affected arms rerun and the report lists both.

## Run

```
export UV_CACHE_DIR=/Volumes/Sharge/cpm-bench/uv-cache
PY=/Volumes/Sharge/cpm-bench/venv/tb-env/bin/python
$PY manifest/prepare.py --out /Volumes/Sharge/cpm-bench/artifacts/<date> --storybloq ../.. \
   --bridge ~/Developer/codex-claude-bridge --tasks-repo <terminal-bench-2 checkout> \
   --arms A0,A1,A2 --claude-code-version <x.y.z> --codex-version <x.y.z> --node-version <x.y.z> \
   --executor-model claude-sonnet-5 --reviewer-model gpt-6-astra --pull-images
$PY manifest/freeze.py .../prepare-manifest.json .../run-manifest.json   # prints the manifest SHA-256 (file bytes)
PYTHONPATH=$PWD /Volumes/Sharge/cpm-bench/venv/tb-env/bin/harbor run --path .../tasks --agent agents.storybloq_auto:StorybloqAuto \
   --ak manifest=.../run-manifest.json --ak arm=A1 --ak version=<claude code pin> \
   -m anthropic/claude-sonnet-5 --ae ANTHROPIC_API_KEY=... -n 1 -o /Volumes/Sharge/cpm-bench/runs/<job> \
   --agent-include-logs '**' 2>&1 | tee /Volumes/Sharge/cpm-bench/runs/<job>.log
$PY report/build_report.py --job A1=/Volumes/Sharge/cpm-bench/runs/<job>/<YYYY-MM-DD__HH-MM-SS> ... \
   [--rerun A1=<job dir holding the single authorised reruns>] \
   [--annotate task:arm:attempt="why the harness and transcript costs differ"] \
   --prices report/prices.json --manifest .../run-manifest.json --out report.md
```

Run from this directory with `PYTHONPATH=$PWD` (the harbor console script does not put the
cwd on sys.path). Harbor writes each job under `<-o dir>/<timestamp>/` with one
`<task>__<id>/` trial directory each; that timestamp directory is what `--job` takes.
Everything the run stores lives on the SSD; nothing benchmark-related goes on the internal disk.

Claude Code is installed from manifest artifacts, never resolved at run time: a
checksum-verified Node linux-x64 tarball (`prepare.py --node-version`) extracted to
`/opt/node`, and a locked install project (`install/claude`, `npm ci --ignore-scripts`, so only
lock-hashed bytes land and no lifecycle script runs) for the pinned
`@anthropic-ai/claude-code`. Its postinstall would only hardlink the linux-x64 platform
package's binary into place; instead the manifest records that binary's SHA-256 and the
container verifies the installed file and links it as `claude` directly. Harbor's own bootstrap installer (a Bun binary) is never used:
the Terminal-Bench images are linux/amd64 only and it segfaults under qemu on Apple Silicon.
Install method, node version and tarball hash are recorded in `versions.json`.

`prepare.py` records the arm schedule (A0 installs nothing), locks one install project per
treatment arm (exactly that arm's tarballs), materialises every task from the recorded git
commit (`git archive`, dirty checkouts refused), snapshots the smoke task beside the pilot
tasks, refuses an existing output directory, and requires an exact `--codex-version`
whenever the bridge is packed. `freeze.py` checks the task snapshot set and hashes, requires dated and sourced
prices, and never overwrites a frozen manifest.

## What is recorded per trial

`agent/versions.json` (manifest hash, versions, measured SKILL.md SHA-256, ticket id,
WORKDIR, preflight, runtime env, `home_after_install`: what the installs left in the real
home. The clean-home isolation gate runs before any install; a second gate after the installs
permits exactly one file on treatment arms, `~/.claude/settings.json` as written by storybloq's
CLI housekeeping (a single `hooks` key, every command a storybloq program), and nothing on A0;
skills, MCP config, Codex state or a foreign hook are pre-start infra errors. The effective
configuration under `CLAUDE_CONFIG_DIR` is asserted again before launch. A hook command passes
only as a single plain invocation of one of the package's two bins (`storybloq`,
`storybloq-presence`) with an audited subcommand: no shell operators,
substitutions, quotes or redirections anywhere in the string), `agent/started.json` (written right before claude is
launched), `agent/infra-failure.json` (written on a PRE-START failure, including a pre-start hang cut by
the task timeout, reason `pre-start-timeout`; the only thing the report accepts as an infra
exclusion), `agent/compliance-error.json` (A0 isolation violated
after the run; the row stays in the denominator, flagged), `agent/claude-code.txt`
(stream-json), `agent/sessions/` (Claude transcripts incl. subagents), `agent/codex-home/`
(Codex rollouts, A2/A4), `agent/story-live/` (incremental copy of `.story/`, each snapshot published by atomic rename
and `last-snapshot` stamped only after a successful copy),
`agent/story.tgz`, `agent/story-status.json`, `agent/story-sessions.json`,
`agent/collect-errors.json`.

## Report rules

Rows are enumerated from the frozen manifest: every scheduled arm needs a job directory, an
unscheduled arm is refused, a scheduled trial without output is a visible missing row and a
build error, and a started trial without a readable result.json is a build error. The ticket
text of every treatment trial is compared byte for byte with `instruction.md` from the
frozen task snapshot. Every started row must carry the report's manifest hash and
arm. Cost is unknown (never zero) when transcript coverage is incomplete (malformed line,
missing usage field, conflicting duplicate message id, cache write without a tier split), when
a model or dimension is unpriced, or when an A2/A4 row's Codex usage is neither complete nor
verified zero (session state present and no Codex round). One rerun of a pre-start infra
failure is allowed; the original stays in the raw listing unselected, anything else is an
error. Harness `total_cost_usd` is reconciled against the transcript at max(0.02, 5%); an
annotated mismatch stays visible with both figures and the explanation.

## Tests

```
$PY -m pytest -q          # 67 tests, no container; adapters run with their real constructors against a strict fake environment
$PY tests/mutants.py      # m1..m10 against report/parse.py: baseline must pass, every mutant must be KILLED by a test failure
```

Smoke gates that need a container: A0 and A1 on `regex-log`; the A2 gate (a `/story auto`
run whose `reviews` round carries a `reviewerSessionId` naming a rollout under the gate's
`CODEX_HOME`); the two recovery trials (`--ak gate_cancel_after_start=true`, and
`--agent-timeout-multiplier 0.01`); the two-process socket probe for the duet arms.

## Prices

`report/prices.json` must carry `date` and a `source` per model, copied from the providers'
official price pages. Unknown model or dimension makes a row's cost unknown; the report
then marks the arm's cost metrics unavailable and prints a labelled lower bound.
