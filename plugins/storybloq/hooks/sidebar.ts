/**
 * T-508: the ledger sidebar Mod. Draws `.story/` beside the transcript.
 *
 * Read-only by construction: it reads the ledger through `$.fs` and never
 * writes it. The write path stays the CLI and the MCP server, as the ticket
 * requires, and `claude plugin validate` prints the calls this module makes so
 * a `$.fs.write` added here would show up in a list the tests compare.
 *
 * WHERE THE NUMBERS COME FROM. `sidebar-projection.ts`, which the repo's own
 * vitest holds equal to `storybloq status --compact`. Nothing in this file
 * counts anything; it reads files, caches what it read, and draws.
 *
 * WHY THE SCAN IS CHUNKED. The compact numbers come from the whole
 * file-per-item ledger, which on a mature project is a couple of thousand
 * files, and `.story/status.json` is not a projection of them (it is a session
 * flag, four fields). A hook that read them all in one go would sit on the
 * client's budget, so the first pass runs in chunks on `$.clock.every` and the
 * pane says how many files are left. Afterwards `$.fs.stat` is the only cost
 * for a file that has not changed: the cache in `$.store` is keyed by path to
 * its mtime and the handful of fields the pane shows, so a later session
 * starts warm and a refresh re-reads only what moved.
 *
 * WIDTH. The client will not draw a pane a plugin opened on its own below 144
 * terminal columns, or below 110 once the person has asked for that id. Below
 * that the same numbers go out as one `AbovePrompt` line, which is how the
 * ticket's 80-column acceptance is met.
 *
 * EVENT NAMES AND `$`. Every event name is a string literal at its `on()` call
 * and every call is spelled `$.noun.member(...)` inline, because the client
 * reads both from this source rather than from a manifest. `client-api.ts` is
 * the documentary pin the tests compare that reading against.
 */

import type { On } from "./mod.js";
import {
  extractRecord,
  projectSidebar,
  type SidebarIssue,
  type SidebarProjection,
  type SidebarRecord,
  type SidebarTicket,
} from "./sidebar-projection.js";

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** The pane's id. Also the `requestId` its `ui.render` and `ui.close` carry. */
const PANE_ID = "storybloq";
const PANE_TITLE = "Storybloq";

/**
 * The narrowest terminal the client will dock a pane into, from the API's own
 * rule: a plugin's unasked open "waits undrawn below 144 columns (110 once
 * asked)". Below this the pane may not be on screen at all, so the one-line
 * fallback draws instead.
 */
const DOCK_MIN_COLUMNS = 110;

const STORE_KEY = "sidebar-ledger-cache-v1";
/** Under the store's 4 MiB, with room for whatever else the plugin keeps. */
const STORE_BUDGET_BYTES = 3_000_000;

/** Files per tick, and the tick, so no single dispatch sits on the budget. */
const SCAN_CHUNK = 25;
const SCAN_TICK_MS = 25;

const TICKETS_DIR = ".story/tickets";
const ISSUES_DIR = ".story/issues";
const HANDOVERS_DIR = ".story/handovers";
const CONFIG_PATH = ".story/config.json";
const ROADMAP_PATH = ".story/roadmap.json";
const STATUS_PATH = ".story/status.json";

interface CachedRecord {
  readonly mtimeMs: number;
  readonly record: SidebarRecord;
}

interface ScanItem {
  readonly path: string;
  readonly kind: "ticket" | "issue";
}

/**
 * Everything this Mod remembers for the session. Module scope, not a closure,
 * so the render hook can draw what the refresh hooks left without awaiting.
 */
let cache: Record<string, CachedRecord> = {};
let cacheLoaded = false;
let projection: SidebarProjection | null = null;
let project = "";
let phases: { readonly id: string; readonly name: string }[] = [];
let handoverFilenames: string[] = [];
let queue: ScanItem[] = [];
let scanning = false;
let ticking = false;
let paneOpen = false;
let sessionActive = false;
let contextPercent: number | null = null;
let warm = false;
let uiAvailable = true;
let saidNoUi = false;

/** Reset between tests; a session only ever loads this module once. */
function forgetEverything(): void {
  cache = {};
  cacheLoaded = false;
  projection = null;
  project = "";
  phases = [];
  handoverFilenames = [];
  queue = [];
  scanning = false;
  ticking = false;
  paneOpen = false;
  sessionActive = false;
  contextPercent = null;
  warm = false;
  uiAvailable = true;
  saidNoUi = false;
}

function isTicketRecord(record: SidebarRecord): record is SidebarTicket {
  return record.kind === "ticket";
}

function isIssueRecord(record: SidebarRecord): record is SidebarIssue {
  return record.kind === "issue";
}

/** Rebuilds the projection from whatever the cache holds right now. */
function reproject(): void {
  const tickets: SidebarTicket[] = [];
  const issues: SidebarIssue[] = [];
  for (const entry of Object.values(cache)) {
    if (isTicketRecord(entry.record)) tickets.push(entry.record);
    else if (isIssueRecord(entry.record)) issues.push(entry.record);
  }
  projection = projectSidebar({ project, phases, tickets, issues, handoverFilenames });
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** The one line the narrow fallback draws, and the pane's own summary row. */
function summaryLine(): string {
  // Until one scan has finished (or a warm cache came out of the store) the
  // numbers are a partial read, and drawing them would be a figure that
  // changes a second later for no reason the reader can see.
  if (!warm || projection === null) {
    return scanning
      ? `Storybloq: reading the ledger, ${queue.length} files left`
      : "Storybloq: no ledger read yet";
  }
  const parts = [
    `${projection.currentPhase ? projection.currentPhase.name : "no phase"}`,
    `${projection.openTickets} open`,
    `${projection.inProgressTickets.length} in progress`,
    `${projection.blockedTickets} blocked`,
    `${projection.openIssues} issues`,
  ];
  if (contextPercent !== null) parts.push(`context ${contextPercent}%`);
  if (scanning) parts.push(`reading ${queue.length}`);
  return `Storybloq: ${parts.join(", ")}`;
}

/** config.json, roadmap.json, the handover names and the session flag. */
async function readHeader($: any): Promise<void> {
  try {
    const configText = await $.fs.read(CONFIG_PATH);
    const parsed = JSON.parse(configText) as { project?: unknown };
    project = typeof parsed.project === "string" ? parsed.project : "";
  } catch {
    project = "";
  }
  try {
    const roadmapText = await $.fs.read(ROADMAP_PATH);
    const parsed = JSON.parse(roadmapText) as { phases?: readonly { id?: unknown; name?: unknown }[] };
    const found: { id: string; name: string }[] = [];
    for (const phase of parsed.phases ?? []) {
      if (typeof phase.id === "string") {
        found.push({ id: phase.id, name: typeof phase.name === "string" ? phase.name : phase.id });
      }
    }
    phases = found;
  } catch {
    phases = [];
  }
  try {
    const entries = await $.fs.list(HANDOVERS_DIR);
    handoverFilenames = entries
      .filter((entry: { kind: string }) => entry.kind === "file")
      .map((entry: { name: string }) => entry.name);
  } catch {
    handoverFilenames = [];
  }
  // status.json is a session flag and nothing else; the ledger numbers do
  // not come from it.
  sessionActive = false;
  if (await $.fs.exists(STATUS_PATH)) {
    try {
      const parsed = JSON.parse(await $.fs.read(STATUS_PATH)) as { sessionActive?: unknown };
      sessionActive = parsed.sessionActive === true;
    } catch {
      sessionActive = false;
    }
  }
}

async function loadCache($: any): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const stored = await $.store.get(STORE_KEY);
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      cache = stored as Record<string, CachedRecord>;
      // A cache from an earlier session is enough to draw real numbers while
      // this session's scan confirms them.
      warm = Object.keys(cache).length > 0;
    }
  } catch {
    cache = {};
  }
}

async function saveCache($: any): Promise<void> {
  const text = JSON.stringify(cache);
  if (text.length > STORE_BUDGET_BYTES) {
    $.ui.log(`storybloq sidebar: the ledger cache is over ${STORE_BUDGET_BYTES} bytes, so it is not kept between sessions`);
    return;
  }
  try {
    await $.store.set(STORE_KEY, cache);
  } catch {
    // A store that refuses costs a cold start next session, nothing more.
  }
}

/**
 * Builds the worklist and starts the ticker. Returns at once: the reading
 * happens a chunk per tick so no dispatch runs long.
 */
function startScan($: any): void {
  if (scanning) return;
  scanning = true;
  void (async () => {
    const items: ScanItem[] = [];
    try {
      for (const entry of await $.fs.list(TICKETS_DIR)) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${TICKETS_DIR}/${entry.name}`, kind: "ticket" });
        }
      }
    } catch {
      // No tickets directory: nothing to read from it.
    }
    try {
      for (const entry of await $.fs.list(ISSUES_DIR)) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${ISSUES_DIR}/${entry.name}`, kind: "issue" });
        }
      }
    } catch {
      // Same.
    }
    // A file the ledger no longer has must leave the cache, or a deleted
    // ticket would keep being counted.
    const present = new Set(items.map((item) => item.path));
    for (const path of Object.keys(cache)) {
      if (!present.has(path)) delete cache[path];
    }
    queue = items;
    reproject();
    $.ui.invalidate("ui.render");
    $.clock.every(SCAN_TICK_MS, () => {
      void drainChunk($);
    });
  })();
}

/**
 * One tick: up to SCAN_CHUNK files, each stat-ed and re-read only when its
 * mtime moved. The mtime check is the whole of "updates within one prompt";
 * serving the cached fields without it is the M-STALE-CACHE mutant.
 */
async function drainChunk($: any): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    let read = 0;
    while (queue.length > 0 && read < SCAN_CHUNK) {
      const item = queue.shift()!;
      read += 1;
      try {
        const stat = await $.fs.stat(item.path);
        const cached = cache[item.path];
        if (cached && cached.mtimeMs === stat.mtimeMs) continue;
        const record = extractRecord(item.kind, await $.fs.read(item.path));
        if (record === null) delete cache[item.path];
        else cache[item.path] = { mtimeMs: stat.mtimeMs, record };
      } catch {
        delete cache[item.path];
      }
    }
    if (queue.length === 0) {
      scanning = false;
      warm = true;
      reproject();
      await saveCache($);
      $.ui.invalidate("ui.render");
    }
  } finally {
    ticking = false;
  }
}

export function registerSidebar(on: On, _options: Options): void {
  forgetEverything();

  // The pane. `ui.render` fires once per input value and again on
  // `$.ui.invalidate("ui.render")`, so this hook only draws what the refresh
  // hooks have already computed: it awaits nothing.
  (on("ui.render", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.component === "Pane" && e.requestId === PANE_ID) {
      const { Box, Text } = $.ui.resolve(e);
      const width: number = typeof e.props?.bodyColumns === "number" ? e.props.bodyColumns : 40;
      const rows: unknown[] = [Text({ bold: true, children: summaryLine() })];
      if (projection !== null) {
        for (const ticket of projection.inProgressTickets.slice(0, 6)) {
          rows.push(Text({ children: truncate(`  ${ticket.id} ${ticket.title}`, width) }));
        }
        const bySeverity = projection.issuesBySeverity;
        rows.push(
          Text({
            dimColor: true,
            children: `  issues: ${bySeverity["critical"] ?? 0} critical, ${bySeverity["high"] ?? 0} high, ${bySeverity["medium"] ?? 0} medium, ${bySeverity["low"] ?? 0} low`,
          }),
        );
        if (projection.latestHandover !== null) {
          rows.push(Text({ dimColor: true, children: truncate(`  handover: ${projection.latestHandover}`, width) }));
        }
        if (sessionActive) rows.push(Text({ dimColor: true, children: "  an autonomous session is active" }));
      }
      return Box({ flexDirection: "column", children: rows });
    }
    // The narrow fallback: the client leaves a plugin's pane undrawn on a
    // small terminal, so the same numbers go out as one line above the prompt.
    // `paneOpen` is false once the person closes it, and `ui.close` says stop
    // redrawing: the fallback is for a pane the client will not draw, not for
    // one they dismissed.
    if (e.component === "AbovePrompt" && paneOpen) {
      const columns: number = typeof e.viewport?.columns === "number" ? e.viewport.columns : 0;
      if (columns > 0 && columns < DOCK_MIN_COLUMNS) {
        const { Text } = $.ui.resolve(e);
        return Text({ dimColor: true, children: truncate(summaryLine(), columns) });
      }
    }
    return next(e);
    // A client without the UI events refuses this registration rather than
    // throwing at the call site; that is the "renders nothing" case, and the
    // scan admits `.catch` here and nothing else.
  }) as { catch: (fn: (error: unknown) => void) => void }).catch(() => {
    uiAvailable = false;
  });

  on("session.start", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable) {
      if (!saidNoUi) {
        saidNoUi = true;
        $.ui.log("storybloq sidebar: this client has no UI render events, so the pane is not drawn");
      }
      return next(e);
    }
    // A `-p` run and the SDK draw nowhere: `surface` is null and nobody is at
    // the prompt, so opening a pane would be a pane nobody asked for.
    if (e.surface !== null && e.isInteractive === true) {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
      paneOpen = true;
    }
    await readHeader($);
    await loadCache($);
    startScan($);
    return next(e);
  });

  // A turn is the unit the acceptance names: a `.story/` write during it shows
  // up by the next prompt.
  on("turn.complete", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable) return next(e);
    const usage = await $.session.usage();
    contextPercent = typeof usage?.context?.percent === "number" ? usage.context.percent : null;
    await readHeader($);
    startScan($);
    return next(e);
  });

  // Deliberately nothing. A tool call is far too frequent to re-read a ledger
  // on, and `turn.complete` already covers the writes a turn made.
  on("tool.call", ($: any, e: any, next: (e: any) => unknown) => next(e));

  on("session.compact", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable) return next(e);
    const usage = await $.session.usage();
    contextPercent = typeof usage?.context?.percent === "number" ? usage.context.percent : null;
    $.ui.invalidate("ui.render");
    return next(e);
  });

  // The person closed it. Stop drawing into it; the narrow line still draws.
  on("ui.close", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.requestId === PANE_ID) paneOpen = false;
    return next(e);
  });
}
