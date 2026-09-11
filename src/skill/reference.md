# storybloq Reference

## CLI Commands

### JSON output envelope

Commands accepting `--format json` wrap their payload in a versioned envelope: `{"version": 1, "data": ...}` on success, `{"version": 1, "error": {"code": ..., "message": ...}}` on failure, plus a `warnings` array on partial loads (exit code 3). Pass `--raw` with `--format json` to emit the `data` payload verbatim: errors keep the envelope, partial-load warnings are dropped (the exit code still signals them), and commands whose JSON is not the standard envelope reject `--raw` naming their shape. A few commands predate the envelope and emit their own JSON instead: `gc`, `limit-status`, `conflicts list`, `conflicts show`, `resolve` and `team reserve` return an `{"ok", "data"}` object, and `team init` and `team setup` return a bare result object. `session list` and `session show` use a text/json axis with their own top-level shapes, and the `bus` subcommands speak the versioned Bus wire format. Every one of these names its own shape in its `--help` and does not accept `--raw` at all, so passing it is rejected during argument validation, before the command runs -- which matters because several of them mutate state.

### init
Initialize a new .story/ project

```
storybloq init [--name <value>] [--force] [--type <value>] [--language <value>] [--node <value>] [--format <json|md>]
```

### status
Project summary: phase statuses, ticket/issue counts, blockers

```
storybloq status [--format <json|md>] [--client-task-id <value>]
```

### ticket list
List tickets with optional filters

```
storybloq ticket list [--status <value>] [--phase <value>] [--type <value>] [--format <json|md>] [--node <value>]
```

### ticket get
Get ticket details by ID

```
storybloq ticket get <id> [--format <json|md>]
```

### ticket next
Suggest next ticket(s) to work on

```
storybloq ticket next [--format <json|md>] [--count <number>]
```

### ticket blocked
List blocked tickets with their blocking dependencies

```
storybloq ticket blocked [--format <json|md>]
```

### ticket create
Create a new ticket

```
storybloq ticket create --title <value> --type <value> [--phase <value>] [--description <value>] [--stdin] [--parent-ticket <value>] [--blocked-by <value>] [--cites-ruling <value>] [--format <json|md>] [--node <value>]
```

### ticket update
Update a ticket

```
storybloq ticket update <id> [--status <value>] [--title <value>] [--type <value>] [--phase <value>] [--order <number>] [--description <value>] [--stdin] [--parent-ticket <value>] [--node <value>] [--force] [--clear-cites-rulings] [--blocked-by <value>] [--cross-node-blocked-by <value>] [--cites-ruling <value>] [--format <json|md>]
```

### ticket meta
Get, set, or unset custom passthrough metadata on a ticket

```
storybloq ticket meta <operation> <id> [path] [value] [--format <json|md>]
```

### ticket delete
Delete a ticket

```
storybloq ticket delete <id> [--force] [--hard] [--format <json|md>]
```

### issue list
List issues with optional filters

```
storybloq issue list [--status <value>] [--severity <value>] [--component <value>] [--phase <value>] [--format <json|md>]
```

### issue get
Get issue details by ID

```
storybloq issue get <id> [--format <json|md>]
```

### issue create
Create a new issue

```
storybloq issue create --title <value> --severity <value> [--impact <value>] [--stdin] [--phase <value>] [--dedupe-key <value>] [--created-by <value>] [--components <value>] [--related-tickets <value>] [--location <value>] [--source-ref <value>] [--cites-ruling <value>] [--format <json|md>]
```

### issue update
Update an issue

```
storybloq issue update <id> [--status <value>] [--title <value>] [--severity <value>] [--impact <value>] [--stdin] [--resolution <value>] [--order <number>] [--phase <value>] [--clear-cites-rulings] [--components <value>] [--related-tickets <value>] [--location <value>] [--source-ref <value>] [--cites-ruling <value>] [--format <json|md>]
```

### issue meta
Get, set, or unset custom passthrough metadata on an issue

```
storybloq issue meta <operation> <id> [path] [value] [--format <json|md>]
```

### issue delete
Delete an issue

```
storybloq issue delete <id> [--hard] [--format <json|md>]
```

### phase list
List all phases with derived status

```
storybloq phase list [--format <json|md>] [--node <value>]
```

### phase current
Show current (first non-complete) phase

```
storybloq phase current [--format <json|md>]
```

### phase tickets
List tickets in a specific phase

```
storybloq phase tickets --phase <value> [--format <json|md>]
```

### phase create
Create a new phase

```
storybloq phase create --id <value> --name <value> --label <value> --description <value> [--summary <value>] [--after <value>] [--at-start] [--node <value>] [--format <json|md>]
```

### phase rename
Rename/update phase metadata

```
storybloq phase rename <id> [--name <value>] [--label <value>] [--description <value>] [--summary <value>] [--format <json|md>]
```

### phase move
Move a phase to a new position

```
storybloq phase move <id> [--after <value>] [--at-start] [--format <json|md>]
```

### phase delete
Delete a phase

```
storybloq phase delete <id> [--reassign <value>] [--format <json|md>]
```

### handover list
List handover filenames (newest first)

```
storybloq handover list [--format <json|md>]
```

### handover latest
Content of most recent handover

```
storybloq handover latest [--count <number>] [--format <json|md>]
```

### handover get
Content of a specific handover

```
storybloq handover get <filename> [--format <json|md>]
```

### handover create
Create a new handover document

```
storybloq handover create [--content <value>] [--stdin] [--slug <value>] [--format <json|md>]
```

### blocker list
List all roadmap blockers

```
storybloq blocker list [--format <json|md>]
```

### blocker add
Add a new blocker

```
storybloq blocker add --name <value> [--note <value>] [--format <json|md>]
```

### blocker clear
Clear (resolve) a blocker

```
storybloq blocker clear --name <value> [--note <value>] [--format <json|md>]
```

### note list
List notes with optional status/tag filters

```
storybloq note list [--status <active|archived>] [--tag <value>] [--format <json|md>]
```

### note get
Get a note by ID

```
storybloq note get <id> [--format <json|md>]
```

### note create
Create a new note

```
storybloq note create [--content <value>] [--title <value>] [--stdin] [--tags <value>] [--format <json|md>]
```

### note update
Update a note

```
storybloq note update <id> [--content <value>] [--title <value>] [--clear-tags] [--status <active|archived>] [--stdin] [--tags <value>] [--format <json|md>]
```

### note delete
Delete a note

```
storybloq note delete <id> [--hard] [--format <json|md>]
```

### lesson list
List lessons with optional status/tag/source filters

```
storybloq lesson list [--status <active|deprecated|superseded>] [--tag <value>] [--source <review|correction|postmortem|manual>] [--format <json|md>]
```

### lesson get
Get a lesson by ID

```
storybloq lesson get <id> [--format <json|md>]
```

### lesson digest
Ranked digest of active lessons for context loading

```
storybloq lesson digest [--format <json|md>]
```

### lesson create
Create a new lesson

```
storybloq lesson create --title <value> [--content <value>] --context <value> --source <review|correction|postmortem|manual> [--supersedes <value>] [--stdin] [--tags <value>] [--format <json|md>]
```

### lesson update
Update a lesson

```
storybloq lesson update <id> [--title <value>] [--content <value>] [--context <value>] [--clear-tags] [--status <active|deprecated|superseded>] [--stdin] [--tags <value>] [--format <json|md>]
```

### lesson reinforce
Reinforce a lesson: increment count and update lastValidated

```
storybloq lesson reinforce <id> [--format <json|md>]
```

### lesson delete
Delete a lesson

```
storybloq lesson delete <id> [--hard] [--format <json|md>]
```

### ruling list
List owner-ruling attestation records

```
storybloq ruling list [--scope-tag <value>] [--superseded] [--format <json|md>]
```

### ruling get
Get a ruling by ID

```
storybloq ruling get <id> [--format <json|md>]
```

### ruling create
Record a ruling verbatim and cite it from the tickets or issues it binds

```
storybloq ruling create --text <value> --attribution <owner-direct|owner-via-manager-with-owner-veto|manager-delegated> --date <value> [--client-task-id <value>] [--scope-tag <value>] [--cites <value>] [--format <json|md>]
```

### ruling supersede
Supersede a ruling: link an existing one with --with, or record a new superseding ruling

```
storybloq ruling supersede <id> [--with <value>] [--text <value>] [--attribution <owner-direct|owner-via-manager-with-owner-veto|manager-delegated>] [--date <value>] [--client-task-id <value>] [--scope-tag <value>] [--format <json|md>]
```

### validate
Reference, schema, source-provenance, and loader-independent JSON checks

```
storybloq validate [--integrity-only] [--format <json|md>]
```

### snapshot
Save current project state for session diffs

```
storybloq snapshot [--quiet] [--format <json|md>]
```

### recap
Session diff: changes since last snapshot + suggested actions

```
storybloq recap [--format <json|md>]
```

### export
Self-contained project document for sharing

```
storybloq export [--phase <value>] [--all] [--format <json|md>]
```

### recommend
Context-aware work suggestions

```
storybloq recommend [--format <json|md>] [--count <number>]
```

### reference
Print CLI command and MCP tool reference

```
storybloq reference [--format <json|md>]
```

### selftest
Run integration smoke test: create/update/delete cycle across all entity types

```
storybloq selftest [--format <json|md>]
```

### codex-review
Run native Codex plan or code review for an autonomous session

```
storybloq codex-review <kind> --session <value> [--format <guide-report>]
```

### limit-status
Show pending usage-limit auto-resumes (global across projects); cancel or requeue records

```
storybloq limit-status [--cancel <value>] [--requeue <value>] [--recent] [--format <json|md>]
```

### setup
Install Storybloq skill, MCP, and hooks for Claude, Codex, or both

```
storybloq setup [--client <claude|codex|all>] [--skip-hooks] [--skip-skill]
```

### setup-skill
Compatibility alias for `storybloq setup --client claude`

```
storybloq setup-skill [--skip-hooks]
```

### reconcile
Detect and fix duplicate displayIds across all entity types

```
storybloq reconcile [--dry-run] [--ci] [--rebalance-ranks] [--format <json|md>]
```

### conflicts list
List all items with unresolved merge conflicts

```
storybloq conflicts list [--format <json|md>]
```

### conflicts show
Show field-level conflict detail for an item

```
storybloq conflicts show <id> [--format <json|md>]
```

### resolve
Resolve merge conflicts on a .story/ item

```
storybloq resolve <id> [--field <value>] [--use <ours|theirs>] [--value <value>] [--format <json|md>]
```

### merge-driver
Git merge driver for .story/ JSON files (registered via team setup)

```
storybloq merge-driver <ancestor> <ours> <theirs> <pathname>
```

### team init
Enable team mode on this project

```
storybloq team init [--claim-staleness-hours <number>] [--id-allocator <local|git-refs>] [--format <json|md>]
```

### team setup
Install the git merge driver and .gitattributes for team mode

```
storybloq team setup [--format <json|md>]
```

### team doctor
Run team health checks on the project

```
storybloq team doctor [--ci] [--format <json|md>]
```

### team reserve
Reserve display IDs via remote git refs

```
storybloq team reserve <type> [--count <number>] [--format <json|md>]
```

### gc
Remove tombstoned files past retention period

```
storybloq gc [--apply] [--force] [--retention-days <number>] [--format <json|md>]
```

### repair
Fix stale references in .story/ data

```
storybloq repair [--dry-run] [--canonicalize-refs]
```

### migrate
Migrate config schema to the latest version

```
storybloq migrate [--dry-run] [--format <json|md>]
```

### dispatch
Dispatch work to Agent View background sessions

```
storybloq dispatch [ids..] [--format <json|md>] [--recommend] [--all] [--count <number>] [--yes] [--dry-run]
```

### bus init
Low-level initializer: enable the local Storybloq Bus v2 for this project (prefer `storybloq bus setup`). Initializes a fresh v2 runtime only; if a v1 runtime is present it refuses with `upgrade_required` and directs you to `storybloq bus setup`, which resolves this task's identity and runs the guided drain/upgrade.

```
storybloq bus init [--format <md|json>]
```

### bus setup
Connect this task to the Storybloq Bus in one idempotent, resumable command. Initializes or upgrades the runtime, joins this task's endpoint, and (when hook delivery is enabled) enables this client's guarded on-boundary hooks. With one endpoint it ends with a handoff line inviting the other task to connect. --replace <endpoint-id> retires a proven-offline incumbent and takes its place, redelivering that endpoint's undelivered mail to this successor. --force-archive overrides unread noncritical v1 delivery only during a v1->v2 upgrade; it never bypasses ship-gate blockers (unacknowledged critical messages, parked unresolved critical threads, quarantined threads).

```
storybloq bus setup [--client <claude|codex>] [--task-id <value>] [--surface <claude_cli|codex_cli|codex_desktop>] [--delivery <live|poll>] [--wake <never|idle>] [--session-name <value>] [--transport-address <value>] [--replace <value>] [--force-archive] [--format <md|json>]
```

### bus auto-attach
Turn per-session Bus auto-attach on or off for this project (opt-in, default off). `on` runs the full `bus setup` bootstrap once (initializing the runtime, joining this task, and installing the global client hooks) and sets the opt-in flag; thereafter every new session auto-attaches at SessionStart with its on-boundary delivery tiers enabled, no command, and a session that finds a proven-dead peer reclaims its slot and inherits its undelivered mail. `off` clears the flag and leaves the runtime and existing endpoints in place.

```
storybloq bus auto-attach <state> [--client <claude|codex>] [--task-id <value>] [--surface <claude_cli|codex_cli|codex_desktop>] [--force-archive] [--format <md|json>]
```

### bus join
Deprecated: roles are now per-message, so the legacy role argument is ignored. Use `storybloq bus setup`.

```
storybloq bus join [legacy-role] [--client <claude|codex>] [--task-id <value>] [--surface <claude_cli|codex_cli|codex_desktop>] [--replace <value>] [--format <md|json>]
```

### bus leave
Retire the Bus endpoint owned by this task

```
storybloq bus leave [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] [--format <md|json>]
```

### bus endpoint retire
Force-retire an endpoint with unknown liveness

```
storybloq bus endpoint retire <endpoint-id> --force --reason <value> [--format <md|json>]
```

### bus send
Create a Bus thread or send a reply. Routing always targets the sole peer; `--to` is deprecated and ignored.

```
storybloq bus send [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] [--thread <value>] [--thread-kind <issue_notice|question|coordination|patch_request>] [--predecessor-thread <value>] [--to <implementer|reviewer>] --kind <issue_notice|question|reply|status|patch_request|claim|release> [--severity <critical|high|medium|low|info>] --body <value> --idempotency-key <value> [--in-reply-to <value>] [--issue <value>] [--ticket <value>] [--commit <value>] [--ci-run <value>] [--file <value>] [--format <md|json>]
```

### bus poll
Poll unacknowledged messages for the task-bound endpoint. --limit bounds how many messages are returned (applies to the wait drain too). With --wait, block until a message arrives or --timeout elapses (v2 only), then exit: 0 = message delivered, 4 = timed out, 5 = another --wait already owns this endpoint.

```
storybloq bus poll [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] [--limit <number>] [--wait] [--timeout <number>] [--format <md|json>]
```

### bus ack
Record delivery disposition for one Bus message

```
storybloq bus ack <message-id> [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] --disposition <accepted|rejected|deferred> [--reason <value>] [--format <md|json>]
```

### bus status
Show concise Bus runtime state

```
storybloq bus status [--format <md|json>]
```

### bus doctor
Validate Bus storage, endpoint, and mailbox integrity

```
storybloq bus doctor [--format <md|json>]
```

### bus check
Run the critical Bus release gate

```
storybloq bus check --ship [--format <md|json>]
```

### bus export
Explicitly export one Bus transcript

```
storybloq bus export <thread-id> [--format <md|json>]
```

### node add
Add a federation node to an orchestrator project

```
storybloq node add <name> --path <value> [--stack <value>] [--role <value>] [--kind <value>] [--summary <value>] [--depends-on <value>] [--link <value>] [--format <json|md>]
```

### node update
Update a federation node's metadata

```
storybloq node update <name> [--path <value>] [--stack <value>] [--role <value>] [--kind <value>] [--summary <value>] [--clear-depends-on] [--clear-links] [--depends-on <value>] [--link <value>] [--format <json|md>]
```

### node remove
Remove a federation node from an orchestrator project

```
storybloq node remove <name> [--force] [--prune] [--format <json|md>]
```

### arrangement coordinate
Record a pen-owned duet coordination operation

```
storybloq arrangement coordinate <id> --json <value> [--client-task-id <value>] [--format <json|md>]
```

### arrangement list
List arrangements

```
storybloq arrangement list [--lifecycle <active|suspended|closed>] [--format <json|md>]
```

### arrangement get
Get an arrangement

```
storybloq arrangement get <id> [--format <json|md>]
```

### arrangement create
Create a new arrangement

```
storybloq arrangement create --unreachability-irreversible <hold|escalate> [--unreachability-reversible <hold|escalate|proceed>] [--bounds <value>] [--party <value>] [--format <json|md>]
```

### arrangement update
Update an arrangement

```
storybloq arrangement update <id> [--lifecycle <active|suspended|closed>] [--format <json|md>]
```

### bus endpoint list
List endpoints with their wake configuration and last wake outcome

```
storybloq bus endpoint list [--format <md|json>]
```

### bus hooks enable
Opt this project into guarded SessionStart and Stop delivery

```
storybloq bus hooks enable [--client <claude|codex|all>] [--format <md|json>]
```

### bus hooks disable
Disable guarded Bus hook delivery for this project

```
storybloq bus hooks disable [--client <claude|codex|all>] [--format <md|json>]
```

### bus redeliver
Redeliver a hop-cap-parked, never-dropped Bus message onto a fresh successor thread

```
storybloq bus redeliver [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] --predecessor-thread <value> --refused-entry-hash <value> [--format <md|json>]
```

### bus thread show
Show an integrity-verified participant thread

```
storybloq bus thread show <thread-id> [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] [--format <md|json>]
```

### bus thread update
Park, resolve, or reopen a participant thread

```
storybloq bus thread update <thread-id> [--endpoint <value>] [--client <claude|codex>] [--task-id <value>] --action <park|resolve|reopen> [--reason <value>] [--resolution <value>] [--commit <value>] [--ci-run <value>] [--format <md|json>]
```

### config set-overrides
Set or clear recipe overrides in config.json

```
storybloq config set-overrides [--json <value>] [--clear] [--deep] [--format <json|md>]
```

### config set-federation
Set federation settings (orchestrator only)

```
storybloq config set-federation [--allow-node-writes] [--format <json|md>]
```

### earmark get
Get the earmark on a ticket or issue

```
storybloq earmark get <ref> [--format <json|md>] [--node <value>]
```

### earmark reserve
Reserve a ticket or issue for a role, pending pickup

```
storybloq earmark reserve <ref> --role <pen|worker> [--arrangement <value>] [--format <json|md>] [--node <value>]
```

### earmark assign
Assign a ticket or issue's earmark directly to a live session (direct placement, or an explicit reserved -> assigned conversion)

```
storybloq earmark assign <ref> --to <value> --role <pen|worker> [--arrangement <value>] [--format <json|md>] [--node <value>]
```

### earmark release
Release (clear) a ticket or issue's earmark

```
storybloq earmark release <ref> [--arrangement <value>] [--format <json|md>] [--node <value>]
```

### feedback list
List community feedback

```
storybloq feedback list [--category <bug|feature|idea>] [--format <json|md>]
```

### feedback create
Create new feedback (opens browser)

```
storybloq feedback create --title <value> [--category <bug|feature|idea>] [--body <value>]
```

### feedback vote
Vote on feedback (opens browser)

```
storybloq feedback vote <number>
```

### gate-ack list
List gate-acks

```
storybloq gate-ack list [--arrangement <value>] [--ticket <value>] [--format <json|md>]
```

### gate-ack get
Get a gate-ack

```
storybloq gate-ack get <id> [--format <json|md>]
```

### gate-ack create
Create a gate-ack

```
storybloq gate-ack create --arrangement <value> --gate <value> --ticket <value> [--plan-file <value>] [--from-staged] [--codex-session-id <value>] [--verdict <value>] [--rounds <number>] [--deltas <value>] [--format <json|md>]
```

### gate-ack contest
Mark a gate-ack contested (record + surfaced flag only)

```
storybloq gate-ack contest <id> --reason <value> [--format <json|md>]
```

### landings
Commits that touched tickets/issues, with review coverage (CLI-only; no MCP tool)

```
storybloq landings [--since <value>] [--limit <number>] [--format <json|md>]
```

### node list
List configured nodes

```
storybloq node list [--format <json|md>]
```

### review-stats
Review efficiency metrics over review verdict artifacts

```
storybloq review-stats [--fleet <value>] [--open-window] [--close-window] [--contract] [--format <json|md>]
```

### session compact-prepare
Prepare session for compaction (PreCompact hook)

```
storybloq session compact-prepare [--client <claude|codex>]
```

### session resume-prompt
Output resume instruction after compaction (SessionStart hook)

```
storybloq session resume-prompt [--codex-hook-json]
```

### session limit-stop
Record a usage-limit stop for auto-resume (StopFailure hook)

```
storybloq session limit-stop
```

### session clear-compact
Clear stale compact marker (admin)

```
storybloq session clear-compact [sessionId] [--force]
```

### session stop
Stop an active session (admin)

```
storybloq session stop [sessionId]
```

### session list
List sessions on disk (admin)

```
storybloq session list [--status <active|completed|superseded|all>] [--format <text|json>]
```

### session show
Show details of a session (admin)

```
storybloq session show <sessionId> [--format <text|json>] [--events <number>]
```

### session repair
Supersede orphaned sessions (admin)

```
storybloq session repair [sessionId] [--dry-run] [--all] [--yes]
```

### session delete
Delete a session directory (admin, destructive)

```
storybloq session delete <sessionId> [--yes]
```

### session health
Derive and display session health state

```
storybloq session health [sessionId]
```

### session watch
Stream session health state changes

```
storybloq session watch [sessionId] [--events] [--quiet]
```

### session milestone
Report a self-described work milestone for presence display (duet/arrangement sessions)

```
storybloq session milestone <kind> [--gate-name <value>] [--note <value>] [--client-task-id <value>] [--format <text|json>]
```

### team config show
Show current team configuration

```
storybloq team config show [--format <json|md>]
```

### team config set
Set a team configuration value

```
storybloq team config set <key> <value> [--format <json|md>]
```

### ticket move
Move a ticket relative to another (fractional rank)

```
storybloq ticket move <id> [--after <value>] [--before <value>] [--format <json|md>]
```

### ticket unclaim
Remove claim from a ticket

```
storybloq ticket unclaim <id> [--format <json|md>]
```

### ticket start
Claim a ticket and set status to inprogress

```
storybloq ticket start <id> [--force] [--format <json|md>]
```

## MCP Tools

The base tools below are registered in full mode (inside a .story/ project). The storybloq_bus_* tools are always registered in full mode; when the Bus is disabled or uninitialized they return setup guidance pointing at `storybloq bus setup`, with no MCP restart required.

Arguments marked ? are optional in the registered schema; handlers may require combinations depending on the action. Use the client’s tool schema for types and constraints.

- **storybloq_status** (format?, clientTaskId?) - Project summary: phase statuses, ticket/issue counts, blockers. Markdown is the default; JSON includes full active/resumable session ownership and lease metadata. clientTaskId (T-477) also enriches this session's own arrangementPresence/ownerIdentity onto its presence record as a side effect; omit to inherit the environment identity, same as storybloq_session_guard.
- **storybloq_phase_list** - All phases with derived status
- **storybloq_phase_current** - First non-complete phase
- **storybloq_phase_tickets** (phaseId, node?) - Leaf tickets for a specific phase
- **storybloq_ticket_list** (status?, phase?, type?, node?) - List leaf tickets with optional filters
- **storybloq_ticket_get** (id, node?) - Get a ticket by ID
- **storybloq_ticket_meta_get** (id, path?) - Get custom passthrough metadata from a ticket
- **storybloq_ticket_next** (count?, node?) - Highest-priority unblocked ticket(s)
- **storybloq_ticket_blocked** (node?) - All blocked tickets with dependencies
- **storybloq_issue_list** (status?, severity?, component?, phase?, node?) - List issues with optional filters
- **storybloq_issue_get** (id, node?) - Get an issue by ID
- **storybloq_issue_meta_get** (id, path?) - Get custom passthrough metadata from an issue
- **storybloq_handover_list** - List handover filenames (newest first)
- **storybloq_handover_latest** (count?) - Content of most recent handover
- **storybloq_handover_get** (filename) - Content of a specific handover
- **storybloq_handover_create** (content, slug?) - Create a handover from markdown content
- **storybloq_blocker_list** - All roadmap blockers with status
- **storybloq_validate** (format?, integrityOnly?) - Reference, schema, source-provenance, and loader-independent JSON checks
- **storybloq_recap** - Session diff: changes since last snapshot
- **storybloq_recommend** (count?, node?) - Context-aware ranked work suggestions
- **storybloq_snapshot** - Save current project state snapshot
- **storybloq_export** (phase?, all?) - Self-contained project document
- **storybloq_note_list** (status?, tag?) - List notes
- **storybloq_note_get** (id) - Get note by ID
- **storybloq_note_create** (content, title?, tags?) - Create note
- **storybloq_note_update** (id, content?, title?, tags?, status?) - Update note
- **storybloq_ticket_create** (title, type, phase?, description?, blockedBy?, parentTicket?, citesRuling?, node?) - Create ticket
- **storybloq_ticket_update** (id, status?, title?, type?, order?, description?, phase?, parentTicket?, blockedBy?, crossNodeBlockedBy?, force?, citesRuling?, clearCitesRulings?, node?) - Update ticket
- **storybloq_ticket_meta_set** (id, path, value?) - Set custom passthrough metadata on a ticket
- **storybloq_ticket_meta_unset** (id, path) - Unset custom passthrough metadata from a ticket
- **storybloq_issue_create** (title, severity, impact, components?, relatedTickets?, location?, sourceRefs?, dedupeKey?, createdBy?, phase?, citesRuling?, node?) - Create issue with optional durable review provenance and retry deduplication
- **storybloq_issue_update** (id, status?, title?, severity?, impact?, resolution?, components?, relatedTickets?, location?, sourceRefs?, order?, phase?, citesRuling?, clearCitesRulings?, node?) - Update issue
- **storybloq_issue_meta_set** (id, path, value?) - Set custom passthrough metadata on an issue
- **storybloq_issue_meta_unset** (id, path) - Unset custom passthrough metadata from an issue
- **storybloq_phase_create** (id, name, label, description, summary?, after?, atStart?) - Create phase in roadmap
- **storybloq_lesson_list** (status?, tag?, source?) - List lessons
- **storybloq_lesson_get** (id) - Get lesson by ID
- **storybloq_lesson_digest** - Ranked digest of active lessons for context loading
- **storybloq_lesson_create** (title, content, context, source, tags?, supersedes?) - Create lesson
- **storybloq_lesson_update** (id, title?, content?, context?, tags?, status?) - Update lesson
- **storybloq_lesson_reinforce** (id) - Reinforce lesson: increment count and update lastValidated
- **storybloq_ruling_list** (scopeTag?, superseded?) - List rulings, optionally filtered by scope tag or superseded state
- **storybloq_ruling_get** (id) - Get a ruling by ID
- **storybloq_ruling_create** (text, attribution, date, scopeTags?, cites?, clientTaskId?) - Record a ruling verbatim; cites adds its id to each named ticket or issue in the same transaction
- **storybloq_ruling_supersede** (id, with?, text?, attribution?, date?, scopeTags?, clientTaskId?) - Supersede a ruling: link an existing one with `with`, or record a new superseding ruling
- **storybloq_selftest** - Integration smoke test: create/update/delete cycle
- **storybloq_review_lenses_prepare** (stage, diff, changedFiles, ticketDescription?, reviewRound?, priorDeferrals?, sessionId?, target?) - Prepare multi-lens review on @storybloq/lenses: activation, secrets gate, context packaging, cited-ruling delivery, complete lens prompts
- **storybloq_review_lenses_synthesize** (stage?, lensResults, activeLenses, skippedLenses, reviewRound?, reviewId?, diff?, changedFiles?, sessionId?, citedRulingsUndelivered?) - Run the @storybloq/lenses merger pipeline programmatically over raw lens outputs; returns the ReviewVerdict envelope (no merger agent). Echo prepare's citedRulingsUndelivered here; without a sessionId it is the only route a delivery hold has
- **storybloq_review_lenses_judge** (reviewVerdict?, convergenceHistory?) - Deterministic three-value verdict mapping over the synthesize ReviewVerdict plus convergence history (no judge agent)
- **storybloq_autonomous_guide** (sessionId, action, clientTaskId?, takeover?, ownerGoneCandidateTakeover?, ownerGoneCandidateCancel?, mode?, reviewEffort?, ticketId?, targetWork?, report?) - Autonomous session orchestrator -- call at every decision point to drive PICK_TICKET through COMPLETE
- **storybloq_session_guard** (clientTaskId?) - Session ownership verdict: is anything running, and may I write? Reads only .story/sessions/, no ledger load. Also registered in degraded mode
- **storybloq_session_milestone** (kind, gateName?, note?, clientTaskId?) - Report a self-described work milestone (implementing/gate-hold/blocked-external/reviewing) onto this session's own presence record, for duet/arrangement visibility. Self-reported, never a computed verdict. gateName is required when kind is gate-hold. On lock contention or write failure, returns an explicit machine-readable retryable error rather than a false success.
- **storybloq_session_report** (sessionId) - Structured analysis of an autonomous session (works even if project state is corrupted)
- **storybloq_register_subprocess** (pid, cmd, category, sessionId) - Register a running subprocess so monitors can tell slow builds from hung agents
- **storybloq_unregister_subprocess** (pid, sessionId) - Unregister a subprocess after it completes (idempotent)
- **storybloq_bus_send** (endpointId, clientTaskId, threadId?, threadKind?, predecessorThreadId?, toRole?, messageKind, severity, body, refs?, inReplyTo?, idempotencyKey) - Send a task-bound advisory peer message; routes to the sole peer (toRole is deprecated, optional, and ignored)
- **storybloq_bus_redeliver** (endpointId, clientTaskId, predecessorThreadId, refusedEntryHash) - Redeliver a hop-cap-parked, never-dropped message onto a fresh successor thread; content is always the resolved refused artifact, never caller-supplied
- **storybloq_bus_poll** (endpointId, clientTaskId, limit?) - Poll a task-bound endpoint mailbox with peer-authority envelopes
- **storybloq_bus_ack** (endpointId, clientTaskId, messageId, disposition, reason?) - Record delivery disposition without resolving canonical work
- **storybloq_bus_thread_get** (endpointId, clientTaskId, threadId) - Read a participant thread's verified prefix and folded state
- **storybloq_bus_thread_update** (endpointId, clientTaskId, threadId, action, reason?, resolution?, evidence?) - Park, resolve, or evidence-reopen a participant thread
- **storybloq_node_list** - List configured federation nodes in an orchestrator project
- **storybloq_node_init** (node, type?, language?, force?) - Initialize .story/ in a federation child node from the orchestrator
- **storybloq_node_add** (name, path, stack?, role?, kind?, summary?, dependsOn?, links?) - Add a federation node to an orchestrator project's config
- **storybloq_node_update** (name, path?, stack?, role?, kind?, summary?, dependsOn?, clearDependsOn?, links?, clearLinks?) - Update a federation node's metadata (shallow-merge)
- **storybloq_arrangement_coordinate** (operation) - Record pen-observed duet coordination state; requires the current session and revision. Receipts are attributed evidence, not authentication.
- **storybloq_arrangement_get** (id, format?) - Get a duet/wave arrangement by ID
- **storybloq_arrangement_create** (bounds, parties, onIrreversibleWork, onReversibleWork?) - Create a new arrangement (duet/wave party charter). Authentication is out of scope: identityAnchor is a name to match, not a credential -- it must be the client task id (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID), never a display name.
- **storybloq_arrangement_update** (id, lifecycle) - Update an arrangement's lifecycle (active/suspended/closed)
- **storybloq_gate_ack_get** (id) - Get a duet-mode gate-ack record by ID
- **storybloq_gate_ack_create** (arrangement, gate, ticket, planFile?, fromStaged?, codexSessionId?, verdict?, rounds?, deltas?) - Create a gate-ack: a pinned acceptance record for a duet-mode arrangement's declared gate (plan-ack or pre-commit-ack). Exactly one of planFile or fromStaged is required to compute the pin. ackRole is derived from the arrangement's own gate declaration, never freely chosen.
- **storybloq_gate_ack_contest** (id, reason) - Record a contested acknowledgment and its reason; does not reopen the workflow.
- **storybloq_earmark_get** (ref, node?) - Get the pick-exclusion earmark (if any) on a ticket or issue
- **storybloq_earmark_reserve** (ref, role, arrangement?, clientTaskId?, node?) - Reserve a ticket or issue for a duet-mode role, pending pickup. Fails as a CAS conflict if already earmarked to someone/something else. --arrangement is required only when more than one active arrangement covers the item.
- **storybloq_earmark_assign** (ref, to, role, arrangement?, clientTaskId?, node?) - Assign a ticket or issue's earmark directly to a live session -- either a fresh placement or an explicit reserved -> assigned conversion. The target session must be live and match an arrangement party holding `role`. A reserved -> assigned conversion is authorized only for the reserver or the arrangement's pen party.
- **storybloq_earmark_release** (ref, arrangement?, clientTaskId?, node?) - Release an earmark as its reserver or the pen of its authorizing arrangement; no-op when absent.

### MCP Tools (degraded mode)

With no .story/ project on the path, the MCP server starts degraded and registers only:

- **storybloq_session_guard** (clientTaskId?) -- the ownership verdict, available here because the no-project case is exactly where the skill runs its Step 0.5 guard first (T-446)
- **storybloq_init** (name, type?, language?) -- bootstrap a .story/ project, then dynamically register the full tool set
- **storybloq_status** (format?) -- returns setup guidance instead of a project summary

Destructive, admin, and git-integration workflows (delete, reconcile, conflicts, resolve, merge-driver, team, gc, repair, config, feedback) are CLI-only in both modes; see the CLI Commands section above.

## Review verdict artifacts

Every review round writes a JSON artifact to `.story/sessions/<sessionId>/telemetry/reviews/`. The filename is `<target>-<stage>-r<round>.json`, and `-g<generation>` is appended once a round belongs to a generation above the first. The generation is a SUFFIX so the `*-code-r*.json` glob external readers already use keeps matching; it is also carried in the payload, so no reader has to parse a filename to know it.

A generation opens whenever the round numbering restarts -- a plan redirect out of code review, or a plan-review reject. Before generations existed, the restarted rounds reproduced existing filenames and were silently dropped; artifacts under one target can therefore still be a mixture of two generations that predate this field.

### Joining a round to what produced it

`backendRunId` carries the backend's own run id and `backendRunIdKind` says what that id is the id OF, which is what decides how precisely a round can be joined:

| `backendRunIdKind` | scope of the run id | join is `exact` when |
|---|---|---|
| `codex-session` | a thread spanning many turns | `backendTurnId` is also present |
| `agent-dispatch` | one dispatch, already a single turn | always -- the dispatch id is turn-precise |
| `lens-review` | one review invocation | always -- the review id is the invocation |

A `backendTurnId` without its parent `backendRunId` joins nothing and reads as `none`, and so does a record carrying neither. ABSENCE IS NEVER READ AS `exact`. Join quality is deliberately not a stored field: it is derived from these ids on every read, because a stored copy can contradict the ids it summarizes.

`reviewAttemptId` identifies one round across all three of its sinks (the state record, this artifact, and the events log); `itemAttemptId` identifies one attempt at one work item across every round of it. Events are best-effort and may duplicate after a crash, so deduplicate by `reviewAttemptId`.

`generation` has TWO readings and `itemAttemptId` is what tells them apart. Where `itemAttemptId` is present, the generation is attempt-scoped lineage: it advances when a redirect restarts the round numbering, so rounds of one attempt at different generations are different rounds and counting distinct generations counts replans. Where `itemAttemptId` is ABSENT, the round had no work item, there is no lineage for the number to describe, and the generation is only a filename discriminator. Rounds with no work item all share the `unknown` filename stem, so two unrelated sequences can meet at one path and one of them is advanced to avoid overwriting the other. Do not count generations as attempts on records that carry no `itemAttemptId`.

### Reading absent values

Every field in this spine is optional, and an absent one means the value was not recorded -- never that it was measured and came back empty. Absence does NOT date a record: a round written today omits `backendRunId` and `backendTurnId` when the backend supplied none, and omits `workItemId` and `itemAttemptId` when the round had no work item at all, so an absent field is not evidence that the record predates the field. Three cases are worth naming because they are easy to misread. An absent `normalizerVersion` means the severities may not be normalized at all, so a `blocking` severity is possible. An absent `artifactStatus` means the artifact's existence is UNKNOWN; it never means the artifact is missing, and it never means one exists. And `reviewerIdentity.evidence` distinguishes what was OBSERVED to run from what was merely CONFIGURED to run -- a pin recorded as `configured` is evidence of intent and never of execution, which is why `unknown`/`none` is a valid and preferred record rather than a guessed model name.

`payloadConsistent` records whether a verdict agreed with the findings it carried. Reading its rate needs care: change-requesting verdicts with zero findings are now repaired before they become rounds, so they are counted in `reviewRepairAttempts` instead. Those are two separate populations and must never be summed.

## /story design

Evaluate frontend code against platform-specific design best practices.

```
/story design                    # Auto-detect platform, evaluate frontend
/story design web                # Evaluate against web best practices
/story design ios                # Evaluate against iOS HIG
/story design macos              # Evaluate against macOS HIG
/story design android            # Evaluate against Material Design
```

Creates issues automatically when storybloq MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.

## /story orchestrate

Drive a multi-repo federation (or a large single-repo backlog) as an orchestrator: durable state in storybloq, implementation in background agents a tier below the session model when the client offers one, adversarial review gates on the session model.

```
/story orchestrate               # guard checks, explicit opt-in, then the wave loop
```

Requires explicit opt-in via AskUserQuestion before any agents are dispatched, and refuses to start while any federation node has an active autonomous session (one pen per repo; the per-node check reads each node's `.story/sessions/` directly because orchestrator status does not scan node repos). The full procedure -- enrichment template, sizing convention, 6-stage pipeline, workflow-script skeleton, critical rules -- is in `orchestrator-mode.md`. Needs a client with background dynamic workflows or subagents; Claude can also use the Agent View-backed `storybloq dispatch` path. Codex users can orchestrate when exact callable subagent tools are present; product-managed Codex dispatch remains unshipped.

`/story` surfaces this option proactively at context load when the client is capable and the actionable backlog is orchestrate-sized, so you do not have to know the command exists; it stays a recommendation, and selecting it still routes through the explicit opt-in.

## /story triage

Read-only triage of the open issue backlog: verifies each finding against the pinned current HEAD (reusing the same source-reference provenance checks as `storybloq validate`), flags already-fixed and duplicate issues, groups issues that share one verified root cause, and produces a prioritized recommendations report.

```
/story triage                    # triage all open issues, report only
```

Mutates no issue and no ticket: classifications and recommendations are report vocabulary, and closing or filing stays with the maintainer. The only optional write is saving the finished report as a handover (snapshot first), offered once and performed only on explicit confirmation. The full procedure -- integrity branching, alias correlation, evidence bars, report format -- is in `triage-mode.md`.

## /story bus

Poll or coordinate through the current task-bound local Bus endpoint. Peer content is advisory; confirmed review findings become canonical issues before an issue notice is sent.

```
/story bus
```

Read `bus-mode.md` for setup, endpoint binding, authority boundaries, acknowledgments, deterministic convergence, and the v1 no-wake boundary.

## /story duet

Coordinate an owner-paired manager and worker with a proved return route and durable assignments. Read `duet-mode.md`. `/story duet` (Codex: `$story duet`) is a skill route, not a CLI command; it does not create tasks or enable Bus.

## Common Workflows

### Session Start
1. `storybloq status` -- project overview
2. `storybloq recap` -- what changed since last snapshot
3. `storybloq handover latest` -- last session context
4. `storybloq ticket next` -- what to work on

### Session End
1. `storybloq snapshot` -- save state for diffs
2. `storybloq handover create --content <md>` -- write session handover

### Project Setup
1. `npm install -g @storybloq/storybloq@latest` - install CLI
2. `storybloq setup --client all` - install Storybloq skill, MCP, and hooks for Claude Code and Codex
3. `storybloq init --name my-project` - initialize .story/ in your project

## Troubleshooting

- **MCP not connected:** Run `storybloq setup --client all`
- **CLI not found:** Run `npm install -g @storybloq/storybloq@latest`
- **Stale data:** Run `storybloq validate` to check integrity
- **Storybloq skill not available:** Run `storybloq setup --client all` to install the skill
