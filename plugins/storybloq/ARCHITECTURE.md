# Dashboard runtime

The Mod is read-only. It derives a view from ledger files and client telemetry; presentation effects never change those inputs.

- `mod.ts` registers the enabled dashboard.
- `sidebar.ts` adapts client events, coordinates scans and cache recovery, and selects the rendered layout. Host calls remain in top-level functions because Claude Code validates their source paths.
- `dashboard-state.ts` creates one state instance per registration. Every asynchronous callback receives or captures that instance, so separate registrations cannot overwrite each other.
- `sidebar-projection.ts` derives ledger counts and board rows without I/O. Fixture tests compare its rules with the CLI.
- `dashboard-view.ts` renders the board, header, footer, and empty states. It performs no host or filesystem calls.
- `dashboard-motion.ts` tracks temporary story, activity, and meter effects with bounded lifetimes and redraw rates.
- `ledger-write-detection.ts` recognizes writes from tool events without executing commands.
- `terminal-text.ts` measures and truncates terminal grapheme clusters.
- `storyfield-logo.ts` generates the startup artwork.

A scan retains cached records on permission or I/O failures and retries them without advancing their cached mtime. Confirmed missing files are removed. Invalid records that are successfully read still follow the projection parser's existing rejection behavior.

The hidden phase timeline has no renderer, effect state, or redraw work. Phase data remains part of the ledger projection and fallback summary.

Run the Vitest plugin and installer tests, strict Mod graph TypeScript checking, and `claude plugin validate` when changing module boundaries. The native `claude plugin test` suite is separate from Vitest; its existing harness and expectations require repair before it can serve as a green release gate on the current client. Do not infer native-suite success from Vitest success.

Context pressure reads the running client session through `session.usage({ breakdown: "summary" })`, using its input tokens and effective auto-compaction threshold. This is a local-only summary. Global settings and native model-window percentages are not substitutes; unavailable thresholds render as unknown. Plugin reloads query the same running session.
