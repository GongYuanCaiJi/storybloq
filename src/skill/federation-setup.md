# Federation Setup -- Multi-Repo Orchestrator Initialization

This file is referenced from SKILL.md when the user runs `/story federation` or describes a multi-repo project setup. SKILL.md has already determined that federation setup is needed before routing here.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you (e.g., `/story` for standalone install, `/story:go` for plugin install).

## What Federation Is

Federation lets one **orchestrator** project coordinate across multiple **node** projects, each in its own repository. Key concepts:

- **Orchestrator**: A storybloq project with `type: "orchestrator"` and a `nodes` map pointing to child project directories. Tracks cross-repo coordination milestones, not per-node implementation work.
- **Nodes**: Independent storybloq projects in separate directories/repos. They don't know they're in a federation -- they work exactly like standalone projects.
- **`dependsOn`**: Build-order topology between nodes. Used for DAG visualization and dispatch ordering.
- **`links`**: Runtime integration points between nodes (informational, not enforced).
- **`crossNodeBlockedBy`**: Ticket field on orchestrator tickets referencing work in node projects (e.g., `["engine:T-010", "client:T-005"]`). Used to block coordination milestones until node work completes.
- **`federation.allowNodeWrites`**: When true, orchestrator MCP tools can write to node `.story/` directories.

The orchestrator does NOT duplicate per-node work. It tracks only cross-node coordination points (milestones). Each node manages its own tickets, phases, issues, and handovers independently.

## Step 0: Check Existing State

Before starting the setup flow, check if the current project is already an orchestrator:

1. Call `storybloq_status` (or read `.story/config.json` directly).
2. If `type` is `"orchestrator"` and nodes are already configured, this is an existing orchestrator. Do NOT restart the full setup flow. Instead, show the current federation state and use `AskUserQuestion`:
   - question: "This project is already an orchestrator. What would you like to do?"
   - header: "Federation"
   - options:
     - "Add more nodes" -- proceed to Step 3 (node registration only)
     - "Show node details" -- call `storybloq node list` via CLI or read `config.json`
     - "Bootstrap uninitialized nodes" -- proceed to Step 4

If NOT an existing orchestrator, continue to Step 1.

## Step 1: Detect Intent and Gather Context

Federation setup triggers when the user says: "multi-repo", "federation", "multiple projects", "orchestrator", "separate repositories", "monorepo with separate repos", or describes a system spanning multiple codebases.

Before asking questions, scan the context:
- Does the user's message list specific project directories or repo names?
- Is there an existing `.story/` in the current directory?
- Are there multiple related project directories nearby?

## Step 2: Interview

Ask the user about their multi-repo setup. Combine into as few `AskUserQuestion` calls as practical.

**Orchestrator location:**

Use `AskUserQuestion`:
- question: "Where should the orchestrator project live?"
- header: "Location"
- options:
  - "Current directory" -- use the current directory as the orchestrator
  - "Create new directory" -- ask for a name, create it
- (Other always available for a specific path)

If the current directory already has `.story/` with `type` != `"orchestrator"`, warn: "This directory has an existing non-orchestrator `.story/`. Converting to orchestrator will change its type and add federation fields. Proceed?" Use `--force` with init.

**Node projects:**

Ask as free text: "List your node projects -- one per line with name, path, and optional runtime links. Example:
```
engine ~/Developer/my-engine
client ~/Developer/my-client [links to engine via wire-protocol]
studio ~/Developer/my-studio [links to engine via streaming-API, links to client via playground]
```"

Parse the response into name/path/links tuples. Validate:
- Names match `^[a-z][a-z0-9_-]{0,63}$`
- Paths point to existing directories
- No duplicates

If the user provides names but no paths (just repo names), ask for paths. Runtime links are optional and informational -- if the user omits them, that's fine.

**Dependencies:**

Ask: "Which nodes depend on which? This defines build order. Example: `client depends on engine`, `studio depends on client, engine`"

Or use `AskUserQuestion` if there are few nodes:
- question: "What's the dependency order?"
- header: "Deps"
- options based on the node list, e.g.:
  - "Linear chain (A -> B -> C)" -- each depends on the previous
  - "Star (all depend on one core)" -- ask which is the core
  - "Independent" -- no dependencies
  - "Custom" -- ask for explicit dependency map

**Write permissions:**

Use `AskUserQuestion`:
- question: "Should orchestrator tools be able to write to node projects' .story/ directories?"
- header: "Writes"
- options:
  - "Yes (Recommended)" -- enables creating tickets, updating status, etc. from the orchestrator
  - "No" -- read-only federation; each node manages its own .story/

## Step 3: Create Orchestrator and Register Nodes

**3a. Initialize the orchestrator:**

If the orchestrator directory doesn't have `.story/` yet:
```
storybloq init --name <name> --type orchestrator
```
Or via MCP: call `storybloq_init` with `type: "orchestrator"`.

If converting an existing project: use `--force`.

**3b. Register each node:**

For each node, in dependency order (leaves first). Include `--link` flags if the user provided runtime links during the interview:
```
storybloq node add engine --path ~/Developer/my-engine --stack swift-spm --role "Core engine"
storybloq node add client --path ~/Developer/my-client --stack npm --role "TypeScript SDK" --depends-on engine --link engine:wire-protocol
storybloq node add studio --path ~/Developer/my-studio --stack npm --role "Web app" --depends-on engine client --link engine:streaming-API --link client:playground
```
Or via MCP: call `storybloq_node_add` with all fields including `links`:
```
storybloq_node_add: name "client", path "~/Developer/my-client", stack "npm",
  dependsOn ["engine"], links [{"to": "engine", "via": "wire-protocol"}]
```

Narrate each registration:
```
-> storybloq . node "engine" added (~/Developer/my-engine, swift-spm)
-> storybloq . node "client" added (~/Developer/my-client, depends on engine, links to engine via wire-protocol)
```

**3c. Set write permissions if requested:**

If the user chose "Yes" for write permissions:
```
storybloq config set-federation --allow-node-writes
```
To disable later: `storybloq config set-federation --no-allow-node-writes`.

## Step 4: Bootstrap Node Projects

For each node that doesn't have `.story/` yet:
```
storybloq init --node <name>
```
Or via MCP: call `storybloq_node_init` with the node name.

This creates `.story/` in the node's directory using the orchestrator's config as context (e.g., inheriting `stack` as the project `type`).

For nodes that already have `.story/`, skip this step for those nodes.

Narrate:
```
-> storybloq . bootstrapped "engine" at ~/Developer/my-engine
-> storybloq . "client" already has .story/, skipping
```

## Step 5: Create Orchestrator Milestones

**Important:** `storybloq init --type orchestrator` already created a "milestones" phase. Use it for all orchestrator tickets. Do NOT create additional phases in the orchestrator -- orchestrator phases are for cross-node coordination milestones only. Per-node work belongs in each node's own phases.

Create milestone tickets in the existing "milestones" phase using `crossNodeBlockedBy`:

```
storybloq ticket create --title "Foundation ready" --type task --phase milestones
storybloq ticket update T-001 --cross-node-blocked-by engine:T-001,client:T-001
```

Or via MCP:
```
storybloq_ticket_create: title "Foundation ready", type "task", phase "milestones"
storybloq_ticket_update: id "T-001", crossNodeBlockedBy ["engine:T-001", "client:T-001"]
```

**Placeholder refs are OK.** The cross-node refs (like `engine:T-001`) reference tickets in node projects. These tickets don't need to exist yet -- they will resolve once node tickets are created during per-node setup (Step 6). This is the expected flow: create milestones first with placeholder refs, then populate nodes.

Only create milestones that make sense for the user's project. Ask what the major cross-repo coordination points are, or infer from the dependency topology. Don't create generic ones.

## Step 6: Per-Node Setup

For each node that was just bootstrapped, offer to run the setup flow:

Use `AskUserQuestion`:
- question: "Set up tickets and phases for each node now?"
- header: "Nodes"
- options:
  - "Yes, guide me through each (Recommended)" -- run the setup-flow.md interview for each node
  - "Set up one at a time" -- start with the first node, return here after each
  - "Skip" -- the user will set up nodes later by cd-ing into each and running `/story`

If "Yes": for each node, either:
- Use MCP tools with the `node` parameter from the orchestrator: `storybloq_ticket_create` with `node: "engine"`, `storybloq_phase_create` with `node: "engine"`, etc. (requires `allowNodeWrites: true`). The `node` parameter is available on MCP tools only, not CLI commands.
- Or instruct the user to open a new terminal in each node directory and run `/story`

After setup is complete, run `storybloq status` from the orchestrator to show the full federation view.

## Reference: Studio Orchestrator Example

The studio project at `~/Developer/studio` is a real 8-node orchestrator managing a media production platform:

```json
{
  "type": "orchestrator",
  "nodes": {
    "engine": {
      "path": "~/Developer/AVEngine",
      "stack": "swift-spm",
      "role": "Headless video/audio engine",
      "health": "green",
      "dependsOn": []
    },
    "conductor": {
      "path": "~/Developer/AVConductor",
      "stack": "swift-spm",
      "role": "Tool domains bridging AgentKit -> Engine + Glaze",
      "health": "red",
      "dependsOn": ["engine", "components", "agent"],
      "links": [
        { "to": "agent", "via": "BackendRouterProvider" },
        { "to": "engine", "via": "EngineSessionBridge" }
      ]
    }
  },
  "federation": {
    "allowNodeWrites": true
  }
}
```

Key patterns:
- The orchestrator has a "milestones" phase with coordination tickets using `crossNodeBlockedBy`
- Each node is an independent project with its own phases, tickets, issues, and handovers
- The dependency graph (via `dependsOn`) drives the Mac app's DAG visualization
- `links` document runtime integration points between nodes
- `health` is updated manually or by federation-aware status scanning
