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
  type SidebarBoardCard,
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

/**
 * The board's row budget per column, derived from the rows the surface gave
 * the pane body (`props.scroll.bodyRows`) less the chrome around the board:
 * the summary line, the column headings, the issues line and the handover
 * line. A pane that reports no rows gets the default.
 */
const DEFAULT_COLUMN_ROWS = 8;
const MIN_COLUMN_ROWS = 3;
const MAX_COLUMN_ROWS = 20;
const BOARD_CHROME_ROWS = 5;

/**
 * Narrower than this and three columns are shredded rather than laid out, so
 * the same three sections stack instead. Well below the 110 the client needs
 * to dock a pane at all, so this is the in-between case: a pane that exists
 * but is too narrow to be a board.
 */
const BOARD_MIN_COLUMNS = 60;

/**
 * The brand mark, rasterized from web/public/brand/logo.png at authoring time.
 *
 * `Raster` takes every cell as a little-endian u32 triplet of code point,
 * foreground and background, base64 encoded. Each row here is one terminal row
 * carrying two pixel rows: the glyph is an upper half block (U+2580), so the
 * foreground paints the top pixel and the background the bottom one, and ten
 * columns by three rows is a twenty by six pixel S. The colour is the mark's
 * own #925834; a pixel the mark does not cover is the terminal's default
 * (0x01000000), so the logo sits on whatever background the person has.
 *
 * A constant and not a fetch: a hooks module has no network, the plugin ships
 * no binary, and reading the PNG would need an $.fs call this Mod does not
 * make. Regenerate by resizing that PNG to 20x6 with its alpha thresholded at
 * 55 and re-encoding.
 */
const LOGO_COLUMNS = 10;
const LOGO_ROWS = 3;
const LOGO_CELLS =
  "gCUAAAAAAAEAAAABgCUAAAAAAAE0WJIAgCUAADRYkgAAAAABgCUAADRYkgAAAAABgCUAADRYkgAAAAABgCUAADRYkgAAAAABgCUAADRYkgAAAAABgCUAADRYkgAAAAABgCUAADRYkgA0WJIAgCUAADRYkgAAAAABgCUAAAAAAAEAAAABgCUAADRYkgAAAAABgCUAADRYkgA0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAEAAAABgCUAAAAAAAE0WJIAgCUAADRYkgA0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAAAAAAAE0WJIAgCUAADRYkgAAAAABgCUAAAAAAAEAAAAB";

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
/** A scan is building its worklist, or has one left to drain. */
let scanInitializing = false;
let scanActive = false;
/** A refresh asked for while a scan was in flight, to run when it finishes. */
let pendingRefresh = false;
let ticking = false;
/** One timer for the module's life, not one per scan. */
let timerStarted = false;
/** The Mod is on and something is drawn: not the same as the pane existing. */
let sidebarEnabled = false;
let paneOpen = false;
let sessionActive = false;
let contextPercent: number | null = null;
let warm = false;
let uiAvailable = true;
let saidNoUi = false;
let saidScanFailed = false;

/** Reset between tests; a session only ever loads this module once. */
function forgetEverything(): void {
  cache = {};
  cacheLoaded = false;
  projection = null;
  project = "";
  phases = [];
  handoverFilenames = [];
  queue = [];
  scanInitializing = false;
  scanActive = false;
  pendingRefresh = false;
  ticking = false;
  timerStarted = false;
  sidebarEnabled = false;
  paneOpen = false;
  sessionActive = false;
  contextPercent = null;
  warm = false;
  uiAvailable = true;
  saidNoUi = false;
  saidScanFailed = false;
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
function summaryLine(withContext: boolean): string {
  // Until one scan has finished (or a warm cache came out of the store) the
  // numbers are a partial read, and drawing them would be a figure that
  // changes a second later for no reason the reader can see.
  const busy = scanActive || scanInitializing;
  if (!warm || projection === null) {
    return busy
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
  if (withContext && contextPercent !== null) parts.push(`context ${contextPercent}%`);
  if (busy) parts.push(`reading ${queue.length}`);
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

/** One guarded line, once: a failing sidebar must not become a chatty one. */
function noteFailure($: any, what: string): void {
  if (saidScanFailed) return;
  saidScanFailed = true;
  try {
    $.ui.log(`storybloq sidebar: ${what}, so the pane may be behind the ledger until a later turn`);
  } catch {
    // A refused log is not worth a second failure.
  }
}

/**
 * ONE timer for the module's life, not one per scan.
 *
 * `$.clock.every` runs until its `cancel()`, and a scan that registered its
 * own would leave it running: two scans, two timers, every later tick paying
 * for both. The callback returns at once unless a scan is actually draining.
 */
function startTimer($: any): void {
  if (timerStarted) return;
  try {
    $.clock.every(SCAN_TICK_MS, () => {
      drainChunk($).catch(() => {
        finalizeScan($, "failed");
      });
    });
  } catch {
    // A hook beneath may refuse the registration. Marking it started before
    // it returned would mean no later attempt is ever made, and a scan begun
    // with no timer builds a queue that nothing drains.
    noteFailure($, "the scan timer could not be started");
    return;
  }
  timerStarted = true;
}

/**
 * The one exit from a scan, whichever way it ended.
 *
 * Releasing the in-flight flags and consuming the pending refresh belong
 * together: a failure path that released the flags but left the pending flag
 * set would strand the request, because every later tick returns at once with
 * no scan active and nothing else reads that flag. Consumed exactly once, so
 * a failed scan nobody asked to repeat is not retried on its own.
 */
function finalizeScan($: any, outcome: "done" | "failed"): void {
  scanActive = false;
  scanInitializing = false;
  ticking = false;
  if (outcome === "failed") noteFailure($, "a ledger scan did not finish");
  if (!pendingRefresh) return;
  pendingRefresh = false;
  requestScan($);
}

/**
 * Asks for a scan, coalescing.
 *
 * A refresh asked for while one is in flight is REMEMBERED, not dropped: the
 * queue the running scan is draining was listed before the write that
 * prompted this call, so that write would otherwise never be listed at all.
 * Many requests during one scan collapse into the single scan that follows it.
 */
function requestScan($: any): void {
  if (scanActive || scanInitializing) {
    pendingRefresh = true;
    return;
  }
  // The timer may still be missing because an earlier registration was
  // refused. Without it a queue would be built that nothing drains, so try
  // again here and start no scan while it is absent.
  startTimer($);
  if (!timerStarted) return;
  beginScan($).catch(() => {
    // The scan is detached, so nothing else would hear this.
    finalizeScan($, "failed");
  });
}

/** Lists the ledger and leaves a queue for the ticker to drain. */
async function beginScan($: any): Promise<void> {
  scanInitializing = true;
  try {
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
    scanActive = true;
    reproject();
    $.ui.invalidate("ui.render");
  } finally {
    scanInitializing = false;
  }
}

/**
 * One tick: up to SCAN_CHUNK files, each stat-ed and re-read only when its
 * mtime moved. The mtime check is the whole of "updates within one prompt";
 * serving the cached fields without it is the M-STALE-CACHE mutant.
 */
async function drainChunk($: any): Promise<void> {
  // The idle guard. Without it every tick after the first scan reprojects the
  // whole ledger, serializes it, writes it to the store and invalidates, for
  // as long as the session lasts.
  if (ticking || !scanActive) return;
  ticking = true;
  let outcome: "done" | "failed" | null = null;
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
      warm = true;
      reproject();
      await saveCache($);
      $.ui.invalidate("ui.render");
      outcome = "done";
    }
  } catch {
    // Whatever failed, this scan is over. Which of the two it was changes
    // only the log line: both leave through the same door.
    outcome = "failed";
  }
  if (outcome === null) {
    ticking = false;
    return;
  }
  finalizeScan($, outcome);
}

/** How many rows one column may draw before it starts counting the rest. */
function columnCap(e: any): number {
  const bodyRows: number = typeof e.props?.scroll?.bodyRows === "number" ? e.props.scroll.bodyRows : 0;
  if (bodyRows <= 0) return DEFAULT_COLUMN_ROWS;
  return Math.max(MIN_COLUMN_ROWS, Math.min(MAX_COLUMN_ROWS, bodyRows - BOARD_CHROME_ROWS));
}

/**
 * One column: a heading carrying the full count, the rows that fit, and a
 * tail saying how many did not.
 *
 * The count in the heading is the WHOLE column, not the rows drawn, so a
 * capped column still tells the truth about the phase; the tail says what the
 * cap cost. Titles are truncated to the column's width, not the pane's.
 *
 * Takes the resolved element table rather than `$`: these are plain
 * constructors, and the client's scan is strict about where `$` may travel.
 */
function boardColumn(
  elements: any,
  key: string,
  heading: string,
  cards: readonly SidebarBoardCard[],
  width: number,
  cap: number,
): unknown {
  const rows: unknown[] = [
    elements.Text({ bold: true, children: truncate(`${heading} ${cards.length}`, width) }),
  ];
  for (const card of cards.slice(0, cap)) {
    rows.push(elements.Text({ children: truncate(`${card.id} ${card.title}`, width) }));
  }
  const hidden = cards.length - Math.min(cards.length, cap);
  if (hidden > 0) rows.push(elements.Text({ dimColor: true, children: `+${hidden} more` }));
  return elements.Box({ key, flexDirection: "column", width, overflow: "hidden", children: rows });
}

/**
 * The three columns, side by side where there is room and stacked where there
 * is not. The keys stay the same either way, so what a column contains does
 * not depend on how it was laid out.
 */
function boardNode(elements: any, board: any, width: number, cap: number): unknown {
  const stacked = width < BOARD_MIN_COLUMNS;
  const columnWidth = stacked ? width : Math.max(12, Math.floor((width - 3) / 4));
  // Left to right in the order the work moves: what is stuck, what can be
  // picked up, what is being done, what is finished.
  return elements.Box({
    key: "board",
    flexDirection: stacked ? "column" : "row",
    gap: 1,
    children: [
      boardColumn(elements, "board-blocked", "Blocked", board.blocked, columnWidth, cap),
      boardColumn(elements, "board-open", "Open", board.open, columnWidth, cap),
      boardColumn(elements, "board-inprogress", "In progress", board.inProgress, columnWidth, cap),
      boardColumn(elements, "board-done", "Done", board.done, columnWidth, cap),
    ],
  });
}

/**
 * The header: the mark and the wordmark on the left, the context fill pushed
 * to the right of the same row.
 *
 * `Raster` is a terminal element; a surface whose table does not carry one
 * gets a bordered letter instead, which is why the table is read for it
 * rather than assumed.
 */
function headerNode(elements: any, context: number | null): unknown {
  const brand = elements.Raster
    ? elements.Raster({ key: "logo", columns: LOGO_COLUMNS, rows: LOGO_ROWS, cells: LOGO_CELLS })
    : elements.Box({ key: "logo", borderStyle: "round", children: [elements.Text({ bold: true, children: "S" })] });
  return elements.Box({
    key: "header",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    children: [
      elements.Box({ key: "brand", flexDirection: "row", gap: 1, alignItems: "center", children: [brand, elements.Text({ bold: true, children: "Storybloq" })] }),
      elements.Text({ dimColor: true, children: context === null ? "" : `context ${context}%` }),
    ],
  });
}

export function registerSidebar(on: On, _options: Options): void {
  forgetEverything();

  // The pane. `ui.render` fires once per input value and again on
  // `$.ui.invalidate("ui.render")`, so this hook only draws what the refresh
  // hooks have already computed: it awaits nothing.
  (on("ui.render", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.component === "Pane" && e.requestId === PANE_ID) {
      const elements = $.ui.resolve(e);
      const { Box, Text } = elements;
      const width: number = typeof e.props?.bodyColumns === "number" ? e.props.bodyColumns : 40;
      const rows: unknown[] = [
        headerNode(elements, contextPercent),
        Text({ children: truncate(summaryLine(false), width) }),
      ];
      if (projection !== null) {
        rows.push(boardNode(elements, projection.board, width, columnCap(e)));
        const bySeverity = projection.issuesBySeverity;
        rows.push(
          Text({
            dimColor: true,
            children: `  issues: ${bySeverity["critical"] ?? 0} critical, ${bySeverity["high"] ?? 0} high, ${bySeverity["medium"] ?? 0} medium, ${bySeverity["low"] ?? 0} low`,
          }),
        );
        for (const [index, name] of projection.latestHandovers.entries()) {
          rows.push(
            Text({ dimColor: true, children: truncate(`${index === 0 ? "handovers: " : "           "}${name}`, width) }),
          );
        }
        if (sessionActive) rows.push(Text({ dimColor: true, children: "  an autonomous session is active" }));
      }
      return Box({ flexDirection: "column", children: rows });
    }
    // The narrow fallback: the client leaves a plugin's pane undrawn on a
    // small terminal, so the same numbers go out as one line above the prompt.
    // Gated on the Mod being on and on the width, and deliberately NOT on
    // the pane existing. Below DOCK_MIN_COLUMNS the client draws no pane at
    // all, so this line IS the sidebar; tying it to `paneOpen` would let a
    // close of something never drawn turn off the only thing that was.
    if (e.component === "AbovePrompt" && sidebarEnabled) {
      const columns: number = typeof e.viewport?.columns === "number" ? e.viewport.columns : 0;
      if (columns > 0 && columns < DOCK_MIN_COLUMNS) {
        const { Text } = $.ui.resolve(e);
        return Text({ dimColor: true, children: truncate(summaryLine(true), columns) });
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
    // the prompt, so there is no pane to open and no ledger worth reading for
    // a sidebar nobody will see.
    if (e.surface === null || e.isInteractive !== true) return next(e);
    sidebarEnabled = true;
    // `session.start` fires again on a reload, and an open of an open id only
    // retitles it, but asking twice is still asking twice.
    if (!paneOpen) {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
      paneOpen = true;
    }
    await readHeader($);
    await loadCache($);
    startTimer($);
    requestScan($);
    return next(e);
  });

  // A turn is the unit the acceptance names: a `.story/` write during it shows
  // up by the next prompt.
  on("turn.complete", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable || !sidebarEnabled) return next(e);
    const usage = await $.session.usage();
    contextPercent = typeof usage?.context?.percent === "number" ? usage.context.percent : null;
    await readHeader($);
    requestScan($);
    return next(e);
  });

  // Deliberately nothing. A tool call is far too frequent to re-read a ledger
  // on, and `turn.complete` already covers the writes a turn made.
  on("tool.call", ($: any, e: any, next: (e: any) => unknown) => next(e));

  on("session.compact", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable || !sidebarEnabled) return next(e);
    const usage = await $.session.usage();
    contextPercent = typeof usage?.context?.percent === "number" ? usage.context.percent : null;
    $.ui.invalidate("ui.render");
    return next(e);
  });

  // The person closed the pane: there is no longer one to draw into, and a
  // later `session.start` may open it again. This does not turn the Mod off,
  // which is why it touches `paneOpen` and not `sidebarEnabled`.
  on("ui.close", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.requestId === PANE_ID) paneOpen = false;
    return next(e);
  });
}
