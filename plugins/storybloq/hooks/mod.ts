/**
 * The storybloq plugin's one hooks module (Claude Code function hooks).
 *
 * hooks/hooks.json names exactly this file: the client admits one module per
 * plugin, so every storybloq Mod registers through here. Each Mod lives in
 * its own file and is gated by its own `userConfig` option, off by default:
 *
 *   - roster.ts   T-507, the seat roster (option `roster`)
 *   - sidebar.ts  T-508, the ledger sidebar (option `sidebar`)
 *
 * The client loads this module only under CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
 * and after workspace trust; with neither option set it registers nothing,
 * so an installed plugin with the Mods off costs no hook on any event. Event
 * names are string literals at every on() call, as the client's source scan
 * requires; the pinned list they are checked against is client-api.ts.
 *
 * The sidebar landed at 72f98679 (T-508); the roster lands with T-507 and
 * wires in at the marked line.
 */

import { registerSidebar } from "./sidebar.js";

export type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;
type Hook = ($: any, e: any, next: (e: any) => unknown) => unknown;
export type On = (event: string, hook: Hook) => unknown;

/** `register(on, options)`: the entry the client calls once per activation. */
export function register(on: On, options: Options): void {
  const roster = options["roster"] === true;
  const sidebar = options["sidebar"] === true;
  if (!roster && !sidebar) return;
  // T-507 wires here: if (roster) registerRoster(on, options);
  if (sidebar) registerSidebar(on, options);
}
