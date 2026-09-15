/**
 * T-508: the ledger sidebar Mod, under `claude plugin test`.
 *
 * WHY THESE DRIVE `registerSidebar` DIRECTLY rather than through the engine's
 * own `$`. The Mod is gated by the `sidebar` userConfig option, off by
 * default, and `claude plugin test` has no way to set a plugin's options: the
 * plugin under test therefore loads with the Mod off and registers nothing, so
 * there is no hook for an engine-dispatched test to reach. Registering it on
 * the test's own `on` instead does not work either, because the host refuses a
 * `$` call whose module's source scan does not list it, and a test file lists
 * none. So the harness below stands in for the engine: a recording `on`, a `$`
 * whose nouns answer from a fixture in memory, and a clock the test turns by
 * hand. What that leaves uncovered is the source scan, which is exactly what
 * `test/plugin/sidebar-validate.test.ts` checks with the client itself.
 *
 * The fixture is a `.story/` as a path-to-text map. Nothing here touches a
 * real filesystem; the hooks environment has none.
 */

import { test, expect } from "claude-code/testing";
import { registerSidebar } from "./sidebar.js";

interface Fixture {
  files: Record<string, string>;
  mtimes: Record<string, number>;
}

function ticketText(over: Record<string, unknown>): string {
  return JSON.stringify({
    id: "T-001",
    title: "A ticket",
    status: "open",
    phase: "p1",
    order: 1,
    blockedBy: [],
    ...over,
  });
}

function issueText(over: Record<string, unknown>): string {
  return JSON.stringify({ id: "ISS-001", title: "An issue", status: "open", severity: "high", ...over });
}

function newFixture(): Fixture {
  const files: Record<string, string> = {
    ".story/config.json": JSON.stringify({ project: "fixture" }),
    ".story/roadmap.json": JSON.stringify({
      phases: [
        { id: "p1", name: "Phase One" },
        { id: "p2", name: "Phase Two" },
      ],
    }),
    ".story/status.json": JSON.stringify({ sessionActive: false }),
    ".story/tickets/T-001.json": ticketText({ id: "T-001", status: "inprogress", title: "Working on it" }),
    ".story/tickets/T-002.json": ticketText({ id: "T-002", status: "open", phase: "p2", order: 2 }),
    ".story/tickets/T-010.json": ticketText({ id: "T-010", status: "open", order: 10, title: "Open ten" }),
    ".story/tickets/T-011.json": ticketText({ id: "T-011", status: "open", order: 11, title: "Open eleven", blockedBy: ["T-001"] }),
    ".story/tickets/T-012.json": ticketText({ id: "T-012", status: "open", order: 12, title: "Open twelve" }),
    ".story/tickets/T-013.json": ticketText({ id: "T-013", status: "open", order: 13, title: "Open thirteen" }),
    ".story/tickets/T-014.json": ticketText({ id: "T-014", status: "open", order: 14, title: "Open fourteen" }),
    ".story/tickets/T-020.json": ticketText({ id: "T-020", status: "complete", order: 20, title: "Done twenty" }),
    ".story/tickets/T-021.json": ticketText({ id: "T-021", status: "complete", order: 21, title: "Done twentyone" }),
    ".story/issues/ISS-001.json": issueText({ severity: "critical" }),
    ".story/handovers/2026-01-02-latest.md": "# Latest",
  };
  const mtimes: Record<string, number> = {};
  for (const path of Object.keys(files)) mtimes[path] = 1000;
  return { files, mtimes };
}

/** The fixture plus `count` more open leaves in the current phase. */
function manyOpen(count: number): Fixture {
  const fixture = newFixture();
  for (let i = 0; i < count; i += 1) {
    const id = `T-1${String(i).padStart(3, "0")}`;
    fixture.files[`.story/tickets/${id}.json`] = ticketText({ id, status: "open", order: 100 + i, title: `Open ${i}` });
    fixture.mtimes[`.story/tickets/${id}.json`] = 1000;
  }
  return fixture;
}

/** The same, in progress, which is the longest column heading. */
function manyInProgress(count: number): Fixture {
  const fixture = newFixture();
  for (let i = 0; i < count; i += 1) {
    const id = `T-2${String(i).padStart(4, "0")}`;
    fixture.files[`.story/tickets/${id}.json`] = ticketText({ id, status: "inprogress", order: 200 + i, title: `Doing ${i}` });
    fixture.mtimes[`.story/tickets/${id}.json`] = 1000;
  }
  return fixture;
}

interface Harness {
  readonly fixture: Fixture;
  readonly opened: unknown[];
  readonly invalidated: string[];
  readonly logged: string[];
  readonly stored: Record<string, unknown>;
  /** What the Mod asked of the host, counted: one timer, one save per scan. */
  readonly counters: { timers: number; storeSets: number };
  /** Arms one rejection, the way a hook beneath may refuse a call. */
  failNextInvalidate: boolean;
  /** Refuses every timer registration while set, the same way. */
  failTimer: boolean;
  /** What `$.session.usage()` answers, in the client's own shape. */
  usage: any;
  /** Refuses every usage read while set, the way a host without it would. */
  failUsage: boolean;
  reads: number;
  fire(event: string, e: unknown): Promise<unknown>;
  tick(times?: number): Promise<void>;
  render(e: unknown): Promise<unknown>;
}

/** Lets every pending promise settle: the fake `$` resolves immediately. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(fixture: Fixture): Harness {
  const hooks: Record<string, (...args: any[]) => any> = {};
  const timers: (() => void)[] = [];
  const opened: unknown[] = [];
  const invalidated: string[] = [];
  const logged: string[] = [];
  const stored: Record<string, unknown> = {};
  // The real shape `$.session.usage()` answers on this client: `window` is
  // always there, `percent` and `tokens` only once the live window has had an
  // API response. The owner's live run had no `percent`, which is why this
  // default carries none.
  const state = {
    reads: 0,
    failNextInvalidate: false,
    failTimer: false,
    failUsage: false,
    usage: { context: { window: 200_000, tokens: 40_000 }, rateLimits: [] } as any,
  };
  const counters = { timers: 0, storeSets: 0 };

  const elements = {
    Box: (props: Record<string, unknown>) => ({ element: "Box", props }),
    Text: (props: Record<string, unknown>) => ({ element: "Text", props }),
    Button: (props: Record<string, unknown>) => ({ element: "Button", props }),
    Code: (props: Record<string, unknown>) => ({ element: "Code", props }),
    Raster: (props: Record<string, unknown>) => ({ element: "Raster", props }),
  };

  const $ = {
    fs: {
      read: async (path: string): Promise<string> => {
        state.reads += 1;
        const text = fixture.files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      list: async (dir: string): Promise<{ name: string; kind: string; size: number }[]> => {
        const names: string[] = [];
        for (const path of Object.keys(fixture.files)) {
          if (!path.startsWith(`${dir}/`)) continue;
          const rest = path.slice(dir.length + 1);
          if (!rest.includes("/")) names.push(rest);
        }
        if (names.length === 0) throw new Error(`ENOENT: ${dir}`);
        return names.sort().map((name) => ({ name, kind: "file", size: fixture.files[`${dir}/${name}`]!.length }));
      },
      exists: async (path: string): Promise<boolean> => fixture.files[path] !== undefined,
      stat: async (path: string): Promise<{ kind: string; size: number; mtimeMs: number }> => {
        if (fixture.files[path] === undefined) throw new Error(`ENOENT: ${path}`);
        return { kind: "file", size: fixture.files[path]!.length, mtimeMs: fixture.mtimes[path]! };
      },
    },
    ui: {
      open: async (pane: unknown): Promise<void> => {
        opened.push(pane);
      },
      close: async (): Promise<void> => {},
      resolve: () => elements,
      invalidate: (event: string): void => {
        if (state.failNextInvalidate) {
          state.failNextInvalidate = false;
          throw new Error("a hook refused ui.invalidate");
        }
        invalidated.push(event);
      },
      log: (message: string): void => {
        logged.push(message);
      },
    },
    session: {
      usage: async () => {
        if (state.failUsage) throw new Error("the host refused session.usage");
        return state.usage;
      },
    },
    store: {
      get: async (key: string): Promise<unknown> => stored[key],
      set: async (key: string, value: unknown): Promise<void> => {
        counters.storeSets += 1;
        stored[key] = JSON.parse(JSON.stringify(value));
      },
    },
    clock: {
      every: (_ms: number, fn: () => void) => {
        if (state.failTimer) throw new Error("a hook refused clock.every");
        counters.timers += 1;
        timers.push(fn);
        return { cancel: () => {} };
      },
    },
  };

  const on = (event: string, hook: (...args: any[]) => any) => {
    hooks[event] = hook;
    return { catch: (_fn: (error: unknown) => void) => undefined };
  };

  registerSidebar(on as any, {});

  return {
    fixture,
    opened,
    invalidated,
    logged,
    stored,
    counters,
    get failNextInvalidate() {
      return state.failNextInvalidate;
    },
    set failNextInvalidate(value: boolean) {
      state.failNextInvalidate = value;
    },
    get failTimer() {
      return state.failTimer;
    },
    set failTimer(value: boolean) {
      state.failTimer = value;
    },
    get failUsage() {
      return state.failUsage;
    },
    set failUsage(value: boolean) {
      state.failUsage = value;
    },
    get usage() {
      return state.usage;
    },
    set usage(value: any) {
      state.usage = value;
    },
    get reads() {
      return state.reads;
    },
    set reads(value: number) {
      state.reads = value;
    },
    async fire(event: string, e: unknown): Promise<unknown> {
      const hook = hooks[event];
      if (!hook) throw new Error(`no hook registered for ${event}`);
      const result = await hook($, e, (passed: unknown) => passed);
      await flush();
      return result;
    },
    async tick(times = 40): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        for (const fn of [...timers]) fn();
        await flush();
      }
    },
    async render(e: unknown): Promise<unknown> {
      const hook = hooks["ui.render"]!;
      return await hook($, e, () => null);
    },
  };
}

const START = { cwd: "/repo", surface: "terminal", isInteractive: true };

// The screen defaults to the rows the pane reports, because that is the case
// the row budget has to survive: a terminal no taller than what was drawn.
function paneEvent(columns = 160, bodyRows = 30, rows = bodyRows): unknown {
  return {
    surface: "terminal",
    component: "Pane",
    requestId: "storybloq",
    viewport: { columns, rows },
    props: {
      title: "Storybloq",
      isFocused: false,
      bodyColumns: columns - 4,
      placement: "dock",
      scroll: { offset: 0, bodyRows },
    },
  };
}

/** The keys of the board's columns, left to right as drawn. */
function columnOrder(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(columnOrder);
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  if (props["key"] === "board") {
    const children = props["children"];
    return (Array.isArray(children) ? children : []).map((child) => {
      const childProps = (child as { props?: Record<string, unknown> }).props ?? {};
      return String(childProps["key"] ?? "");
    });
  }
  return columnOrder(props["children"]);
}

/** One node found by the key it carries, or null. */
function nodeByKey(node: unknown, key: string): any {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = nodeByKey(child, key);
      if (hit) return hit;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  if (props["key"] === key) return node;
  return nodeByKey(props["children"], key);
}

/**
 * One string per drawn line under a node: a Text is one line, a Box is its
 * children's lines in order. Nested Text (an id and a title in one row) stays
 * one line, which is how the client lays it out.
 */
function textRows(node: unknown): string[] {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap(textRows);
  if (typeof node !== "object") return [];
  const element = (node as { element?: string }).element;
  if (element !== "Box") return [textOf(node)];
  return textRows((node as { props?: Record<string, unknown> }).props?.["children"]);
}

/** One row per drawn line of a column, heading first, rule included. */
function rowsOf(tree: unknown, key: string): string[] {
  return textRows(nodeByKey(tree, key));
}

/** The card rows of a column: everything below the heading and its rule. */
function cardsOf(tree: unknown, key: string): string[] {
  return rowsOf(tree, key).slice(2);
}

/** One row per line the pane draws, top to bottom. */
function paneRows(tree: unknown): string[] {
  const children = (tree as { props?: Record<string, unknown> })?.props?.["children"];
  const list: unknown[] = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return list.map((child) => textOf(child));
}

/** The heading line of one column. */
function headingOf(tree: unknown, key: string): string {
  return rowsOf(tree, key)[0] ?? "";
}

/** The text of one board column, found by the key its Box carries. */
function columnText(node: unknown, key: string): string {
  if (node === null || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((child) => columnText(child, key)).join(" ");
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  if (props["key"] === key) return textOf(node);
  return columnText(props["children"], key);
}

function abovePromptEvent(columns: number): unknown {
  return {
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "above-prompt",
    viewport: { columns, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: columns },
  };
}

/** Terminal cells a string takes, for the width assertions. */
function cells(text: string): number {
  let width = 0;
  let joined = false;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0x200d) {
      joined = true;
      continue;
    }
    if (point === 0xfe0f) continue;
    if (joined) {
      joined = false;
      continue;
    }
    const wide =
      (point >= 0x1100 && point <= 0x115f)
      || (point >= 0x2e80 && point <= 0xa4cf)
      || (point >= 0xac00 && point <= 0xd7a3)
      || (point >= 0xf900 && point <= 0xfaff)
      || (point >= 0xff00 && point <= 0xff60)
      || (point >= 0x1f300 && point <= 0x1f9ff)
      || (point >= 0x20000 && point <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Every string in a drawn tree, flattened, so an assertion can look for one.
 *
 * A Text's own children run together with no separator, the way the client
 * lays inline Text out; a Box's children are separated, since they are
 * different rows or columns.
 */
function textOf(node: unknown, separator = " "): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => textOf(child, separator)).join(separator);
  if (typeof node === "object") {
    const element = (node as { element?: string }).element;
    const props = (node as { props?: Record<string, unknown> }).props ?? {};
    const inline = element === "Text" || props["flexDirection"] === "row";
    return textOf(props["children"], inline ? "" : separator);
  }
  return "";
}

async function started(h: Harness): Promise<void> {
  await h.fire("session.start", START);
  await h.tick();
}

test("draws the pane with the ledger's numbers", async () => {
  const h = harness(newFixture());
  await started(h);

  const tree = await h.render(paneEvent());
  const text = textOf(tree);
  // One leaf in progress; one open issue, at critical.
  expect(headingOf(tree, "board-inprogress")).toBe("In progress 1");
  expect(text).toContain("1 critical");
  expect(text).toContain("T-001");
});

test("opens the pane once, on an interactive session with a surface", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(h.opened).toEqual([{ id: "storybloq", title: "Storybloq" }]);
});

test("opens no pane where nothing is drawn and nobody is at the prompt", async () => {
  const h = harness(newFixture());
  await h.fire("session.start", { cwd: "/repo", surface: null, isInteractive: false });
  await h.tick();
  expect(h.opened).toEqual([]);
});

test("a .story/ write shows up after the turn that made it", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");

  // Someone completes the in-progress ticket. Its mtime moves, which is the
  // only signal the Mod has: serving the cached fields regardless is the
  // M-STALE-CACHE mutant, and it fails right here.
  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  h.fixture.mtimes[".story/tickets/T-001.json"] = 2000;

  await h.fire("turn.complete", {});
  await h.tick();

  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 0");
});

test("re-reads only the file whose mtime moved", async () => {
  const h = harness(newFixture());
  await started(h);

  h.reads = 0;
  h.fixture.files[".story/tickets/T-002.json"] = ticketText({ id: "T-002", status: "complete", phase: "p2", order: 2 });
  h.fixture.mtimes[".story/tickets/T-002.json"] = 3000;
  await h.fire("turn.complete", {});
  await h.tick();

  // config.json, roadmap.json and status.json are read whole every refresh
  // (three files, fixed cost); of the ledger only the one that moved.
  expect(h.reads).toBe(4);
});

test("invalidates the render when a scan finishes, so the pane is not stale", async () => {
  const h = harness(newFixture());
  await h.fire("session.start", START);

  // Mid-scan the pane can only say what it is doing, and that answer is what
  // the client will hold until something invalidates it.
  const duringScan = h.invalidated.length;
  expect(textOf(await h.render(abovePromptEvent(80)))).toContain("reading the ledger");

  await h.tick();

  // M-NO-INVALIDATE: counting invalidations is not enough, because the scan
  // invalidates once at its start too. What matters is one AFTER the numbers
  // settled; without it the loading line is what stays on screen.
  expect(h.invalidated.length).toBeGreaterThan(duringScan);
  expect(textOf(await h.render(abovePromptEvent(80)))).not.toContain("reading the ledger");
});

test("invalidates again after a turn re-reads a changed file", async () => {
  const h = harness(newFixture());
  await started(h);
  const settled = h.invalidated.length;

  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  h.fixture.mtimes[".story/tickets/T-001.json"] = 2000;
  await h.fire("turn.complete", {});
  await h.tick();

  expect(h.invalidated.length).toBeGreaterThan(settled);
});

test("falls back to one line above the prompt on a narrow terminal", async () => {
  const h = harness(newFixture());
  await started(h);

  // 80 columns: the client will not draw a plugin's pane this narrow, so the
  // ticket's 80-column acceptance is met by this line. M-PANE-ALWAYS drops it.
  const narrow = textOf(await h.render(abovePromptEvent(80)));
  expect(narrow).toContain("Storybloq:");
  expect(narrow).toContain("issues");

  // Wide enough to dock: the pane carries it and the band stays out of the way.
  expect(textOf(await h.render(abovePromptEvent(160)))).toBe("");
});

test("keeps the fallback line inside the terminal's width", async () => {
  const h = harness(newFixture());
  await started(h);
  const narrow = textOf(await h.render(abovePromptEvent(60)));
  expect(narrow.length).toBeLessThanOrEqual(60);
});

test("does not re-read the ledger on a tool call", async () => {
  const h = harness(newFixture());
  await started(h);

  h.reads = 0;
  await h.fire("tool.call", { tool: "Read", input: { file_path: "/repo/x.ts" } });
  await h.tick();

  expect(h.reads).toBe(0);
});

test("passes a tool call on untouched", async () => {
  const h = harness(newFixture());
  await started(h);
  const event = { tool: "Read", input: { file_path: "/repo/x.ts" } };
  expect(await h.fire("tool.call", event)).toBe(event);
});

test("keeps the narrow fallback after the person closes the pane", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(textOf(await h.render(abovePromptEvent(80)))).toContain("Storybloq:");

  // Closing a pane the client was never going to draw at this width cannot be
  // what turns the fallback off: at 80 columns the line IS the sidebar, and
  // the person closed something they could not see. M-CLOSE-KILLS-FALLBACK
  // ties the two together and this goes red.
  await h.fire("ui.close", { requestId: "storybloq", origin: "person" });
  expect(textOf(await h.render(abovePromptEvent(80)))).toContain("Storybloq:");
});

test("registers one timer for the session, not one per scan", async () => {
  const h = harness(newFixture());
  await started(h);
  for (let turn = 0; turn < 3; turn += 1) {
    await h.fire("turn.complete", {});
    await h.tick();
  }
  // M-TIMER-PER-SCAN: a timer per scan is a timer that is never cancelled, so
  // every later tick runs the whole callback chain once per scan ever started.
  expect(h.counters.timers).toBe(1);
});

test("does nothing on a tick with no scan to run", async () => {
  const h = harness(newFixture());
  await started(h);
  const saves = h.counters.storeSets;
  const invalidations = h.invalidated.length;

  await h.tick(20);

  // M-IDLE-TICK: without the idle guard every tick reprojects, serializes the
  // whole ledger and writes it to the store, forever.
  expect(h.counters.storeSets).toBe(saves);
  expect(h.invalidated.length).toBe(invalidations);
});

test("picks up a write made while the first scan was still running", async () => {
  const h = harness(newFixture());
  // The scan is initialized but nothing has drained yet.
  await h.fire("session.start", START);

  h.fixture.files[".story/tickets/T-003.json"] = ticketText({
    id: "T-003",
    status: "inprogress",
    title: "Arrived mid scan",
  });
  h.fixture.mtimes[".story/tickets/T-003.json"] = 1500;
  await h.fire("turn.complete", {});
  await h.tick();

  // M-DROP-REFRESH: a refresh asked for during a scan is dropped by the
  // in-flight guard, and this file was not in the queue that scan built, so
  // nothing ever lists it again.
  expect(textOf(await h.render(paneEvent()))).toContain("Arrived mid scan");
});

test("a refused invalidate does not wedge every later scan", async () => {
  const h = harness(newFixture());
  h.failNextInvalidate = true;
  await h.fire("session.start", START);
  await h.tick();

  h.failNextInvalidate = false;
  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  h.fixture.mtimes[".story/tickets/T-001.json"] = 2000;
  await h.fire("turn.complete", {});
  await h.tick();

  // M-STUCK-SCAN: the throw is what matters a turn LATER, not on the turn it
  // happened. A detached scan that leaves its in-flight flag set makes every
  // later request return early, so this write is never picked up. Asserting
  // the state before the write would pass under the mutant, because the first
  // scan's queue was already built and still drains.
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 0");
});

test("shows the context pressure once a turn has reported it", async () => {
  const h = harness(newFixture());
  await started(h);
  await h.fire("session.compact", {});
  expect(textOf(await h.render(paneEvent()))).toContain("context 20%");
});

test("keeps the ledger cache in the store, so the next session starts warm", async () => {
  const h = harness(newFixture());
  await started(h);
  const cache = h.stored["sidebar-ledger-cache-v1"] as Record<string, { mtimeMs: number }>;
  expect(Object.keys(cache).sort()).toEqual([
    ".story/issues/ISS-001.json",
    ".story/tickets/T-001.json",
    ".story/tickets/T-002.json",
    ".story/tickets/T-010.json",
    ".story/tickets/T-011.json",
    ".story/tickets/T-012.json",
    ".story/tickets/T-013.json",
    ".story/tickets/T-014.json",
    ".story/tickets/T-020.json",
    ".story/tickets/T-021.json",
  ]);
  expect(cache[".story/tickets/T-001.json"]!.mtimeMs).toBe(1000);
});

test("says how much is left while the first scan runs", async () => {
  const h = harness(newFixture());
  await h.fire("session.start", START);
  // One tick short of the end: the ledger is still being read.
  expect(textOf(await h.render(abovePromptEvent(80)))).toContain("reading the ledger");
});

test("drops a ticket that left the ledger", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");

  delete h.fixture.files[".story/tickets/T-001.json"];
  await h.fire("turn.complete", {});
  await h.tick();

  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 0");
});

test("runs the refresh that was asked for during a scan that then failed", async () => {
  const h = harness(newFixture());
  // The scan is initialized with its queue built, and nothing has drained.
  await h.fire("session.start", START);

  h.fixture.files[".story/tickets/T-003.json"] = ticketText({
    id: "T-003",
    status: "inprogress",
    title: "Arrived mid scan",
  });
  h.fixture.mtimes[".story/tickets/T-003.json"] = 1500;
  await h.fire("turn.complete", {});

  // The scan now fails at the very end, after its files are read: the pending
  // request is the only record that a refresh is owed.
  h.failNextInvalidate = true;
  await h.tick();

  // M-PENDING-LOST: a failure path that clears the in-flight flags but leaves
  // the pending flag set strands the request. Later ticks return at once
  // because no scan is active, so the write waits for a turn that may never
  // come.
  expect(textOf(await h.render(paneEvent()))).toContain("Arrived mid scan");
});

test("recovers when the scan timer could not be registered at first", async () => {
  const h = harness(newFixture());
  h.failTimer = true;
  await h.fire("session.start", START);
  await h.tick();

  // Nothing could drain, so nothing should have been started either.
  expect(textOf(await h.render(abovePromptEvent(80)))).not.toContain("1 in progress");

  h.failTimer = false;
  await h.fire("turn.complete", {});
  await h.tick();

  // M-TIMER-FLAG-EARLY: marking the timer started before the registration
  // returns means no later attempt is ever made, so a scan is begun with
  // nothing to drain it and the pane never leaves its loading line.
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");
});

test("draws a board of the whole project, in four columns", async () => {
  const h = harness(newFixture());
  await started(h);
  const text = textOf(await h.render(paneEvent()));

  expect(text).toContain("Blocked");
  expect(text).toContain("Open");
  expect(text).toContain("In progress");
  expect(text).toContain("Done");
  expect(text).toContain("T-010");
  expect(text).toContain("T-001");
  expect(text).toContain("T-021");
});

test("keeps each status to its own column", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // M-COLUMN-MIX puts a complete ticket in Open and this fails.
  expect(columnText(tree, "board-open")).toContain("T-010");
  expect(columnText(tree, "board-open")).not.toContain("T-020");
  expect(columnText(tree, "board-blocked")).toContain("T-011");
  expect(columnText(tree, "board-inprogress")).toContain("T-001");
  expect(columnText(tree, "board-done")).toContain("T-020");
  expect(columnText(tree, "board-done")).not.toContain("T-010");
});

test("shows every phase's leaves, not just the current phase's", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // T-002 is the only ticket of phase two, and the board is the project's:
  // M-PHASE-ONLY filters back to the current phase and loses it.
  expect(columnText(tree, "board-open")).toContain("T-002");
  expect(headingOf(tree, "board-open")).toBe("Open 5");
});

test("gives a blocked ticket its own column, out of Open", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // T-011 waits on T-001, which is in progress; T-010 waits on nothing.
  // M-BLOCKED-UNMARKED drops the split and T-011 sits in Open, where nothing
  // tells the reader it cannot be picked up.
  expect(columnText(tree, "board-blocked")).toContain("T-011");
  expect(columnText(tree, "board-open")).not.toContain("T-011");
  expect(columnText(tree, "board-open")).toContain("T-010");
});

test("orders the columns as the work moves", async () => {
  const h = harness(newFixture());
  await started(h);
  // M-COLUMN-ORDER shuffles them and this fails.
  expect(columnOrder(await h.render(paneEvent()))).toEqual([
    "board-blocked",
    "board-open",
    "board-inprogress",
    "board-done",
  ]);
});

test("heads every column with the whole count, not the rows that fit", async () => {
  const h = harness(manyOpen(12));
  await started(h);
  // Seventeen open tickets, of which six are drawn. The heading still says
  // seventeen: M-COUNT-MISMATCH heads it with the drawn rows instead, and a
  // capped column then under-reports the phase. This is the figure the owner
  // read live, where Done said 27 over eighteen drawn rows.
  expect(headingOf(await h.render(paneEvent()), "board-open")).toBe("Open 17");
});

test("keeps a three digit count when the column is too narrow for the heading", async () => {
  const h = harness(manyInProgress(99));
  await h.fire("session.start", START);
  await h.tick(80);
  // A hundred in progress at sixty columns: each of the four columns is
  // fourteen wide and "In progress 100" is fifteen. The LABEL is what gives
  // way, never the count. M-COUNT-CUT truncates the whole heading, which
  // leaves "In progress 1…" and reports a number the column does not have.
  const heading = headingOf(await h.render(paneEvent(64)), "board-inprogress");

  expect(heading.endsWith(" 100")).toBe(true);
  expect(heading).not.toContain("In progress");
  expect(heading.length).toBeLessThanOrEqual(14);
});

test("keeps a four digit count whole as well", async () => {
  const h = harness(manyInProgress(999));
  await h.fire("session.start", START);
  await h.tick(200);
  // The count grows a digit and the label gives up another character rather
  // than the count losing one.
  const heading = headingOf(await h.render(paneEvent(64)), "board-inprogress");
  expect(heading.endsWith(" 1000")).toBe(true);
});

test("heads the pane with the wordmark alone", async () => {
  const h = harness(newFixture());
  await started(h);
  await h.fire("turn.complete", {});
  const tree = await h.render(paneEvent());
  const header = textOf(nodeByKey(tree, "header"));

  expect(header).toContain("Storybloq");
  // The owner took the rasterized mark out; the wordmark is the brand. The
  // phase went with it once the board stopped being one phase's, and the
  // context fill went to the foot of the pane. M-CONTEXT-TOP draws it here
  // again.
  expect(nodeByKey(tree, "logo")).toBe(null);
  expect(header).not.toContain("Phase");
  expect(header).not.toContain("context");
});

test("works out the context fill from the fields the usage actually carries", async () => {
  const h = harness(newFixture());
  await started(h);
  // This is the live shape: SessionContextUsage states `window` always and
  // `percent` only once the window has had an API response, so the header
  // stayed empty against a read that wanted `percent`. M-PERCENT-ONLY puts
  // that read back and this goes red.
  h.usage = { context: { window: 200_000, tokens: 50_000 }, rateLimits: [] };
  await h.fire("turn.complete", {});
  expect(textOf(nodeByKey(await h.render(paneEvent()), "footer"))).toContain("context 25%");
});

test("prefers the percent the engine states over its own arithmetic", async () => {
  const h = harness(newFixture());
  await started(h);
  // The engine's own figure counts the window the way the status line does,
  // so where it exists it wins.
  h.usage = { context: { window: 200_000, tokens: 50_000, percent: 73 }, rateLimits: [] };
  await h.fire("turn.complete", {});
  expect(textOf(nodeByKey(await h.render(paneEvent()), "footer"))).toContain("context 73%");
});

test("says nothing about context on a window that has had no response yet", async () => {
  const h = harness(newFixture());
  await started(h);
  // A fresh session, or one just compacted: neither figure exists, and a made
  // up zero would read as an empty window rather than an unknown one.
  h.usage = { context: { window: 200_000 }, rateLimits: [] };
  await h.fire("turn.complete", {});
  expect(textOf(nodeByKey(await h.render(paneEvent()), "footer"))).not.toContain("context");
});

test("keeps the handover names off the board", async () => {
  const h = harness(newFixture());
  h.fixture.files[".story/handovers/2026-01-03-newest.md"] = "# Newest";
  h.fixture.mtimes[".story/handovers/2026-01-03-newest.md"] = 1000;
  await started(h);

  // The owner took them off: cleaner as a board. The projection still names
  // them (its own test pins the order), but the pane draws none of it, and
  // M-HANDOVERS-BACK puts the rows back.
  const text = textOf(await h.render(paneEvent()));
  expect(text).not.toContain(".md");
  expect(text).not.toContain("handovers:");
  // The issues line under the board stays.
  expect(text).toContain("issues: 1 critical");
});

test("caps a column at six and ends it with dots", async () => {
  const h = harness(manyOpen(12));
  await started(h);
  // Seventeen open tickets: six rows and a dotted tail, in a pane with the
  // rows to spare. M-CAP-IGNORED draws all seventeen and writes no tail,
  // which is the column that ran off the bottom of the owner's pane;
  // M-ROW-OVERFLOW ignores the budget that keeps the tail on screen, and
  // M-CAP-EIGHT leaves the cap at the eight it was before the owner asked
  // for the height back.
  const tree = await h.render(paneEvent(160, 30));
  const cards = cardsOf(tree, "board-open");

  expect(cards.length).toBe(7);
  expect(cards[6]).toBe("...");
  expect(cards.slice(0, 6).every((row) => row.startsWith("T-"))).toBe(true);
  expect(headingOf(tree, "board-open")).toBe("Open 17");
});

test("treats a seventh card as the tail, not as a seventh card", async () => {
  const h = harness(manyOpen(2));
  await started(h);

  // Exactly seven open: the cap is six, so the seventh row is the tail and
  // not a card. M-NINE-CARDS leaves the count unclamped and the column draws
  // all seven with nothing to say it was capped, which is the one case where
  // the heading and the rows disagree without anyone noticing.
  const tree = await h.render(paneEvent(160, 30));
  const cards = cardsOf(tree, "board-open");

  expect(headingOf(tree, "board-open")).toBe("Open 7");
  expect(cards.length).toBe(7);
  expect(cards[6]).toBe("...");
  expect(cards.slice(0, 6).every((row) => row.startsWith("T-"))).toBe(true);
});

test("leaves a column that fits without a tail, and levels the four bodies", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent(160, 30));

  // Five open tickets, so nothing is left out and there is nothing to say.
  expect(cardsOf(tree, "board-open")).toEqual([
    "T-002 A ticket",
    "T-010 Open ten",
    "T-012 Open twelve",
    "T-013 Open thirteen",
    "T-014 Open fourteen",
  ]);
  // And every body draws the same number of rows, the shorter ones padded,
  // so the four cards end level. M-RAGGED-BODIES lets them end where they
  // like.
  const heights = ["board-blocked", "board-open", "board-inprogress", "board-done"].map(
    (key) => cardsOf(tree, key).length,
  );
  expect(heights).toEqual([5, 5, 5, 5]);
});

test("says so in a column with nothing in it", async () => {
  const h = harness(newFixture());
  // Nothing is blocked once the blocker is finished.
  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  await started(h);
  const tree = await h.render(paneEvent(160, 30));

  expect(headingOf(tree, "board-blocked")).toBe("Blocked 0");
  expect(cardsOf(tree, "board-blocked")[0]).toBe("none");
});

test("sets the issues line flush left under the board", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // It was indented two spaces, which read as a hanging line under a board
  // that is itself flush left. It shares its row with the context fill, which
  // is right-aligned on the same line at the foot of the pane.
  expect(textOf(nodeByKey(tree, "issues"))).toBe("issues: 1 critical, 0 high, 0 medium, 0 low");
  expect(paneRows(tree).length).toBe(5);
  expect(paneRows(tree)[4]).toContain("issues:");
});

test("breaks the header off the board with one blank row that actually draws", async () => {
  const h = harness(newFixture());
  await started(h);
  const rows = paneRows(await h.render(paneEvent()));

  // Five rows: the header, the break, the board, a second break, the issues
  // line. A break has to be a row the client will DRAW, which an empty string
  // is not: it collapses to no height, which is why the owner saw the
  // wordmark sitting straight on top of "Blocked". So this counts rows and
  // pins the content, and M-NO-HEADER-BREAK (an empty string, or no row at
  // all) fails here.
  expect(rows.length).toBe(5);
  expect(rows[0]).toContain("Storybloq");
  expect(rows[1]).toBe(" ");
  expect(rows[1]!.length).toBeGreaterThan(0);
  expect(rows[2]).toContain("Blocked");
  expect(rows[2]).toContain("Done");
  expect(rows[3]).toBe(" ");
  expect(rows[4]).toContain("issues:");
});

test("draws one bordered card per column, its heading ruled off from the body", async () => {
  const h = harness(newFixture());
  await started(h);
  const keys = ["board-blocked", "board-open", "board-inprogress", "board-done"];

  // Below the stacking threshold each card takes the pane's whole width;
  // above it the four share it, less the three gaps. The bound is the event's
  // own bodyColumns, not a number fitted to one terminal.
  for (const columns of [50, 110, 144, 158, 160]) {
    const bodyColumns = columns - 4;
    const stacked = bodyColumns < 60;
    const tree = await h.render(paneEvent(columns, 30));
    const board = nodeByKey(tree, "board");
    const widths = keys.map((key) => nodeByKey(tree, key).props.width as number);

    for (const key of keys) {
      const column = nodeByKey(tree, key);
      const width = column.props.width as number;
      // One box, not two: M-TWO-BOXES puts the heading back in a bordered box
      // of its own, which drew a double line between heading and body.
      expect(typeof column.props.borderStyle).toBe("string");
      expect(nodeByKey(tree, `${key}-heading`).element).toBe("Text");
      // The rule under the heading spans the inner width exactly, so it meets
      // both side borders.
      expect(rowsOf(tree, key)[1]!.length).toBe(width - 2);
      expect(rowsOf(tree, key)[1]).toMatch(/^\u2500+$/);
      // The border costs a column each side, so every line has to be that
      // much narrower or the row wraps and the board comes apart.
      for (const row of rowsOf(tree, key)) expect(row.length).toBeLessThanOrEqual(width - 2);
    }

    // M-NO-GAP closes the column gap the owner asked for.
    expect(board.props.gap).toBe(stacked ? 0 : 1);
    if (stacked) {
      expect(widths).toEqual([bodyColumns, bodyColumns, bodyColumns, bodyColumns]);
    } else {
      // The four widths and the three gaps fill the pane exactly.
      expect(widths.reduce((sum, w) => sum + w, 0) + 3).toBe(bodyColumns);
    }
  }
});

test("weights the board toward the work in hand on a wide pane", async () => {
  const h = harness(newFixture());
  await started(h);

  // Narrow enough and the four columns are even.
  const even = await h.render(paneEvent(110, 30));
  expect(nodeByKey(even, "board-inprogress").props.width).toBe(nodeByKey(even, "board-done").props.width);

  // From 158 columns up, about a twentieth of the pane moves from Done to In
  // progress: M-EQUAL-WIDTHS-WIDE leaves them even and this fails.
  for (const columns of [162, 200]) {
    const tree = await h.render(paneEvent(columns, 30));
    const inProgress = nodeByKey(tree, "board-inprogress").props.width as number;
    const done = nodeByKey(tree, "board-done").props.width as number;
    const blocked = nodeByKey(tree, "board-blocked").props.width as number;
    expect(inProgress).toBeGreaterThan(done);
    expect(inProgress - blocked).toBe(blocked - done);
    // And the pane is still filled exactly.
    const total = ["board-blocked", "board-open", "board-inprogress", "board-done"]
      .map((key) => nodeByKey(tree, key).props.width as number)
      .reduce((sum, w) => sum + w, 0);
    expect(total + 3).toBe(columns - 4);
  }
});

test("emphasises the column being worked, and lets the finished one recede", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent(160, 30));
  const heading = (key: string) => nodeByKey(tree, `${key}-heading`).props;

  // In progress is the only bold coloured heading; Done recedes.
  // M-DONE-LOUD gives Done the same weight and this fails.
  expect(heading("board-inprogress").color).toBe("cyan");
  expect(heading("board-inprogress").bold).toBe(true);
  expect(heading("board-blocked").color).toBe("yellow");
  expect(heading("board-blocked").bold).toBeUndefined();
  expect(heading("board-open").color).toBeUndefined();
  expect(heading("board-open").bold).toBeUndefined();
  expect(heading("board-done").dimColor).toBe(true);
  expect(heading("board-done").color).toBeUndefined();
  expect(heading("board-done").bold).toBeUndefined();
});

/**
 * The rows a drawn tree occupies, the way the client lays it out: a Text is
 * one row, a column Box its children plus its gaps, a row Box the tallest of
 * them, and a border adds one row above and one below.
 */
/** The cells a node asks for: its own width if it names one, else its text. */
function nodeWidth(node: unknown): number {
  const props = (node as { props?: Record<string, unknown> })?.props ?? {};
  return typeof props["width"] === "number" ? (props["width"] as number) : cells(textOf(node));
}

/**
 * A node that cuts its own text rather than letting the row wrap it.
 *
 * The client's `wrap` takes seven values and exactly one of them wraps, so a
 * test that took any string for truncation would call `wrap: "wrap"` safe.
 */
const TRUNCATING_WRAPS = ["end", "middle", "truncate", "truncate-start", "truncate-middle", "truncate-end"];

function truncates(node: unknown): boolean {
  const element = (node as { element?: string })?.element;
  const props = (node as { props?: Record<string, unknown> })?.props ?? {};
  return element !== "Box" && TRUNCATING_WRAPS.includes(props["wrap"] as string);
}

// Pass a width and the wrapping is counted too: a Text that names a `wrap`
// keeps to one row however long it is, and one that does not takes as many
// rows as its content needs. Without a width nothing wraps, which is what
// every row-budget test measures.
function paneHeight(node: unknown, width = Infinity): number {
  if (node === null || node === undefined) return 0;
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + paneHeight(child, width), 0);
  if (typeof node !== "object") return 0;
  const element = (node as { element?: string }).element;
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  const own = typeof props["width"] === "number" ? (props["width"] as number) : width;
  if (element !== "Box") {
    if (truncates(node)) return 1;
    return Math.max(1, Math.ceil(cells(textOf(node)) / own));
  }
  const children = props["children"];
  const list: unknown[] = Array.isArray(children) ? children : children === undefined ? [] : [children];
  const border = typeof props["borderStyle"] === "string" ? 2 : 0;
  const gap = typeof props["gap"] === "number" ? (props["gap"] as number) : 0;
  if (props["flexDirection"] === "row") {
    // Children that do not truncate are wrapped by the row they overflow, so
    // a row wider than its box costs the rows its content needs.
    const natural = list.reduce((sum: number, child) => sum + nodeWidth(child), 0);
    if (natural > own && list.some((child) => !truncates(child))) {
      return border + Math.ceil(natural / own);
    }
    return border + list.reduce((tallest: number, child) => Math.max(tallest, paneHeight(child, own)), 0);
  }
  return border + list.reduce((sum: number, child) => sum + paneHeight(child, own), 0) + gap * Math.max(0, list.length - 1);
}

test("draws no more rows than the pane gave it", async () => {
  const h = harness(manyOpen(12));
  await started(h);

  // The pane clips at bodyRows without saying so, which is how the owner lost
  // a tail and two footer lines. M-ROW-OVERFLOW spends the whole budget on
  // cards and this fails at every size.
  for (const bodyRows of [12, 18, 25]) {
    for (const columns of [50, 160]) {
      const tree = await h.render(paneEvent(columns, bodyRows));
      expect(paneHeight(tree)).toBeLessThanOrEqual(bodyRows);
      // And the board is still a board: every column still carries its count.
      for (const key of ["board-blocked", "board-open", "board-inprogress", "board-done"]) {
        expect(headingOf(tree, key)).toMatch(/ \d+$/);
      }
    }
  }
});

test("draws the whole board on a tall terminal whatever the pane reports", async () => {
  const h = harness(manyOpen(12));
  await started(h);

  // The owner's reload: 213 columns on a 61 row terminal, and the pane drew
  // the compact fallback where the build before drew a full column of cards.
  // `scroll.bodyRows` is the height of the tree we last drew, not the room we
  // have, so a short board makes the next budget shorter and the pane never
  // climbs back out. M-BUDGET-SELF-LIMIT takes the field as the cap again and
  // every one of these collapses to four counted rows.
  for (const reported of [0, 4, 6, 16]) {
    const tree = await h.render(paneEvent(213, reported, 61));
    const cards = cardsOf(tree, "board-open");
    expect(nodeByKey(tree, "board-open").element).toBe("Box");
    expect(cards.length).toBe(7);
    expect(cards[6]).toBe("...");
    expect(headingOf(tree, "board-open")).toBe("Open 17");
    expect(paneRows(tree)[1]).toBe(" ");
  }
});

test("drops the blank rows before it drops a card", async () => {
  const h = harness(manyOpen(12));
  await started(h);

  // Twelve rows side by side: the gaps are affordable. Nine is not, so the
  // blank rows go first and the cards stay.
  const roomy = paneRows(await h.render(paneEvent(160, 12)));
  expect(roomy[1]).toBe(" ");

  const tight = await h.render(paneEvent(160, 9));
  expect(paneRows(tight).some((row) => row === " ")).toBe(false);
  expect(cardsOf(tight, "board-open").length).toBeGreaterThan(0);
  expect(paneHeight(tight)).toBeLessThanOrEqual(9);
});

test("falls back to four counted rows when no frame will fit", async () => {
  const h = harness(manyOpen(12));
  await started(h);

  // Stacked, four framed cards need their frames before a single card is
  // drawn. Under that the board is the four counts and nothing else, which is
  // still the board.
  const tree = await h.render(paneEvent(50, 12));
  expect(paneHeight(tree)).toBeLessThanOrEqual(12);
  expect(headingOf(tree, "board-open")).toBe("Open 17");
  expect(nodeByKey(tree, "board-open").element).toBe("Text");
});

test("measures a title in terminal cells, not in characters", async () => {
  const h = harness(newFixture());
  // A CJK title, an emoji title and an ASCII one, all far too long. A wide
  // character takes two cells, so counting characters overruns the column by
  // one cell per character and the row wraps: M-WIDE-CHAR counts characters.
  h.fixture.files[".story/tickets/T-030.json"] = ticketText({ id: "T-030", status: "open", order: 30, title: "点点点点点点点点点点点点点点点点点点点点点点点点点点" });
  h.fixture.files[".story/tickets/T-031.json"] = ticketText({ id: "T-031", status: "open", order: 31, title: "🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥" });
  h.fixture.files[".story/tickets/T-032.json"] = ticketText({ id: "T-032", status: "open", order: 32, title: "a".repeat(120) });
  h.fixture.mtimes[".story/tickets/T-030.json"] = 1000;
  h.fixture.mtimes[".story/tickets/T-031.json"] = 1000;
  h.fixture.mtimes[".story/tickets/T-032.json"] = 1000;
  await started(h);

  for (const columns of [110, 158, 258]) {
    const tree = await h.render(paneEvent(columns, 30));
    const width = nodeByKey(tree, "board-open").props.width as number;
    for (const row of cardsOf(tree, "board-open")) {
      expect(cells(row)).toBeLessThanOrEqual(width - 2);
    }
    // The id survives whole and only the title is cut, with one ellipsis
    // where there was any cutting to do.
    const cjk = cardsOf(tree, "board-open").find((row) => row.startsWith("T-030")) ?? "";
    expect(cjk.startsWith("T-030 ")).toBe(true);
    expect(cjk.split("…").length).toBeLessThanOrEqual(2);
    if (columns < 258) expect(cjk.endsWith("…")).toBe(true);
  }
});

test("cuts a title between glyphs, never inside one", async () => {
  // Its own open column, four tickets and no more: with the fixture's own
  // open leaves beside them the last of these falls past the cap, the row is
  // absent, and an assertion that walks its characters walks nothing and
  // passes whatever the cut did.
  const fixture = newFixture();
  for (const id of ["T-002", "T-010", "T-011", "T-012", "T-013", "T-014"]) {
    delete fixture.files[`.story/tickets/${id}.json`];
    delete fixture.mtimes[`.story/tickets/${id}.json`];
  }
  const h = harness(fixture);
  // A joined emoji, an emoji spelled with the variation selector, a letter
  // carrying a combining mark, and a bare surrogate pair. The measure
  // suppresses the code point after a zero-width joiner and a cut that walks
  // code points counts it again, so the two disagree by a code point per
  // joiner and the cut lands inside the glyph: M-SPLIT-EMOJI walks code
  // points and the woman is parted from her laptop.
  const titles: Record<string, string> = {
    "T-040": "👩‍💻".repeat(14),
    "T-041": "♥️".repeat(24),
    "T-042": "é".repeat(40),
    "T-043": "𝔘".repeat(40),
  };
  for (const [id, title] of Object.entries(titles)) {
    const path = `.story/tickets/${id}.json`;
    h.fixture.files[path] = ticketText({ id, status: "open", order: Number(id.slice(2)), title });
    h.fixture.mtimes[path] = 1000;
  }
  await started(h);

  for (const columns of [110, 158]) {
    const rows = cardsOf(await h.render(paneEvent(columns, 30)), "board-open");
    const row = (id: string): string => rows.find((text) => text.startsWith(id)) ?? "";

    // Every one of them is on the board: an absent row asserts nothing.
    for (const id of Object.keys(titles)) expect(row(id)).not.toBe("");

    // Every joiner still joins two halves, and none dangles at the cut.
    const joined = row("T-040");
    expect(joined).toContain("👩‍💻");
    expect([...joined].filter((c) => c === "‍").length).toBe([...joined].filter((c) => c === "👩").length);
    expect(joined.includes("‍…")).toBe(false);
    expect(joined.endsWith("‍")).toBe(false);

    // A variation selector belongs to the glyph before it and a combining
    // mark to the letter before it, so what stands before the ellipsis is a
    // whole glyph and never its bare base.
    for (const [id, mark] of [["T-041", "️"], ["T-042", "́"]] as const) {
      const text = row(id);
      expect(text.endsWith("…")).toBe(true);
      expect(text.slice(0, -1).endsWith(mark)).toBe(true);
    }

    // And a surrogate pair is never halved, which would draw a lone unit.
    for (const character of row("T-043")) {
      const point = character.codePointAt(0) ?? 0;
      expect(point < 0xd800 || point > 0xdfff).toBe(true);
    }
  }
});

test("colours the severities that exist and dims the ones that do not", async () => {
  const h = harness(newFixture());
  h.fixture.files[".story/issues/ISS-002.json"] = issueText({ id: "ISS-002", severity: "high" });
  h.fixture.mtimes[".story/issues/ISS-002.json"] = 1000;
  await started(h);
  const tree = await h.render(paneEvent(160, 30));
  // The fragments hang inside the one truncating Text that holds the row.
  const line = (nodeByKey(tree, "issues").props.children as any[])[0];
  const parts = (line.props.children as any[]).filter(
    (child) => typeof child?.props?.children === "string" && /\d/.test(child.props.children),
  );

  // critical 1, high 1, medium 0, low 0. M-DIM-CRITICAL dims a bucket that
  // has something in it, or colours one that does not.
  expect(parts[0].props.children).toBe("1 critical");
  expect(parts[0].props.color).toBe("red");
  expect(parts[1].props.children).toBe("1 high");
  expect(parts[1].props.color).toBe("yellow");
  expect(parts[2].props.children).toBe("0 medium");
  expect(parts[2].props.dimColor).toBe(true);
  expect(parts[2].props.color).toBeUndefined();
  expect(parts[3].props.dimColor).toBe(true);
  // The context fill stays neutral.
  expect(nodeByKey(tree, "context").props.color).toBeUndefined();
});

test("shortens the severity labels when the row is too narrow for them", async () => {
  const h = harness(newFixture());
  await started(h);

  // Wide enough for the long labels.
  expect(textOf(nodeByKey(await h.render(paneEvent(160, 30)), "issues"))).toContain("1 critical");
  // Not wide enough: the context fill keeps its width and the issues line
  // gives up its words rather than its numbers.
  const narrow = await h.render(paneEvent(48, 30));
  const text = textOf(nodeByKey(narrow, "issues"));
  expect(text).toContain("1 crit");
  expect(text).not.toContain("critical");
  expect(textOf(nodeByKey(narrow, "context"))).toBe("context 20%");
});

test("keeps the issues line to one row when the counts outgrow the room", async () => {
  const fixture = newFixture();
  // Counts in the hundreds: "234 crit 345 high 456 med 567 low" is far wider
  // than a forty column pane has left once the context fill has its share.
  const severities = ["critical", "high", "medium", "low"];
  for (let i = 0; i < 400; i += 1) {
    const path = `.story/issues/ISS-${100 + i}.json`;
    fixture.files[path] = issueText({ id: `ISS-${100 + i}`, severity: severities[i % 4] });
    fixture.mtimes[path] = 1000;
  }
  const h = harness(fixture);
  await started(h);

  // One row, not two. M-FOOTER-WRAPS drops the truncation and the row wraps,
  // which spends a row the budget counted for the board.
  const tree = await h.render(paneEvent(40, 30));
  expect(textOf(nodeByKey(tree, "context"))).toBe("context 20%");
  expect(paneHeight(nodeByKey(tree, "footer"), 40)).toBe(1);
  // And the numbers are still there to be cut, not quietly dropped first.
  expect(textOf(nodeByKey(tree, "issues"))).toContain("101 crit");
});

test("keeps the header clear of the cell the engine draws its close mark in", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // This pins the CLEARANCE CONTRACT, not what a terminal shows: the header
  // row stops short of the pane's last cells, where the engine draws its own
  // close mark. Live it read "context 7%×" with the mark hard against our
  // string, and only the owner's eye can confirm the fix landed; what a test
  // can hold is that the margin is still asked for. M-MARK-COLLISION drops
  // it. The foot of the pane needs none: the mark is a top-right thing.
  expect(nodeByKey(tree, "header").props.marginRight).toBeGreaterThanOrEqual(3);
  expect(nodeByKey(tree, "footer").props.marginRight).toBeUndefined();
  expect(textOf(nodeByKey(tree, "footer"))).toContain("context 20%");
});

test("moves a ticket on the board during the turn that moved it", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");

  // The owner moved a ticket to in progress mid turn, waited, and moved it
  // back; the board never budged, because nothing asked for a scan until the
  // turn ended. M-STALE-BOARD leaves tool.call a passthrough and this fails.
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;
  await h.fire("tool.call", { tool: "mcp__storybloq__storybloq_ticket_update", tool_use_id: "call-1" });
  await h.tick();

  const tree = await h.render(paneEvent());
  expect(headingOf(tree, "board-inprogress")).toBe("In progress 2");
  expect(headingOf(tree, "board-open")).toBe("Open 4");
  expect(columnText(tree, "board-inprogress")).toContain("T-010");
  expect(columnText(tree, "board-open")).not.toContain("T-010");
});

test("takes the same ledger write from the CLI's own tool name", async () => {
  const h = harness(newFixture());
  await started(h);
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "complete", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;
  await h.fire("tool.call", { tool: "storybloq_ticket_update", tool_use_id: "call-2" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-done")).toBe("Done 3");
});

test("rescans after an edit aimed at a ledger file, and not after any other", async () => {
  const h = harness(newFixture());
  await started(h);

  // The ticket moves on disk first; what the two calls below differ in is
  // whether the board is allowed to notice. Counting reads would prove
  // nothing here, since a scan of an unchanged ledger reads no file at all.
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  await h.fire("tool.call", { tool: "Edit", tool_use_id: "c3", file_path: "/repo/src/index.ts" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");

  await h.fire("tool.call", { tool: "Edit", tool_use_id: "c4", file_path: "/repo/.story/tickets/T-010.json" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");
});

test("does not sweep the ledger for a tool that only read it", async () => {
  const h = harness(newFixture());
  await started(h);

  // A read is by far the common case, and a sweep per read would be the cost
  // the chunked scan exists to avoid. The prefix is not enough on its own:
  // the verb at the end of the name is what says a write happened. The ledger
  // has already moved here, so a board that moves with it is the proof that
  // the read triggered a scan.
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  for (const tool of ["mcp__storybloq__storybloq_status", "storybloq_ticket_list", "Read", "Grep"]) {
    await h.fire("tool.call", { tool, tool_use_id: `read-${tool}` });
    await h.tick();
    expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");
  }

  // And the write that follows them does move it, so the board was only ever
  // one call away from the truth.
  await h.fire("tool.call", { tool: "storybloq_ticket_update", tool_use_id: "write-1" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");
});

test("never sweeps for a tool that only looked at the ledger", async () => {
  const h = harness(newFixture());
  await started(h);

  // The ledger has already moved. Every call below names .story/ and none of
  // them changed it, so a board that moves is a sweep that should not have
  // happened: M-READ-SWEEP leaves the path branch open to any tool and
  // M-BASH-ALL lets any Bash command that mentions the directory through.
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  const lookers: Record<string, unknown>[] = [
    { tool: "Read", file_path: "/repo/.story/tickets/T-001.json" },
    { tool: "Glob", path: "/repo/.story", pattern: "**/*.json" },
    { tool: "Grep", path: "/repo/.story/tickets", pattern: "inprogress" },
    { tool: "LS", path: "/repo/.story" },
    { tool: "Bash", command: "cat .story/config.json" },
    { tool: "Bash", command: "ls .story/tickets | head" },
    { tool: "Bash", command: "grep -r inprogress .story/tickets" },
    { tool: "Bash", command: "git status .story/" },
    // The CLI reading, not writing: the prefix is not enough on its own here
    // either.
    { tool: "Bash", command: "storybloq status --compact" },
    { tool: "Bash", command: "storybloq ticket list --phase p1" },
  ];
  for (const [index, looker] of lookers.entries()) {
    await h.fire("tool.call", { ...looker, tool_use_id: `look-${index}` });
    await h.tick();
    expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");
  }
});

test("sweeps for a Bash command that can have written the ledger", async () => {
  const h = harness(newFixture());
  await started(h);
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  // The verb is in subcommand position, so the CLI wrote whatever path it
  // resolved for itself.
  await h.fire("tool.call", { tool: "Bash", command: "storybloq ticket update T-001 --status complete", tool_use_id: "b1" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");
});

test("reads the direction of a Bash command, not just the words in it", async () => {
  const h = harness(newFixture());
  await started(h);

  // Every command here touches the ledger and none of them writes it. The
  // ledger has already moved, so a board that moves is a sweep that should
  // not have happened. M-REDIRECT-FROM-LEDGER takes any mutation beside any
  // mention of the directory, so the two that read OUT of it sweep;
  // M-VERB-ANYWHERE takes a writing word anywhere after `storybloq`, so the
  // tag filter and the quoted line sweep.
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  const readers = [
    "cat .story/tickets/T-001.json > /tmp/x.json",
    "cp .story/tickets/T-001.json /tmp/x.json",
    "storybloq note list --tags update",
    'echo "storybloq ticket update"',
    "cat .story/config.json\ngrep -c inprogress .story/tickets/T-001.json\nls .story/handovers",
    // A separator inside quotes is text, not a separator: M-QUOTED-SEPARATOR
    // cuts the line before it reads the quotes and the tail looks like a call.
    'echo "x; storybloq ticket update T-001"',
    // And so is a redirect: M-QUOTED-REDIRECT reads this as a write into the
    // ledger when it prints a greater-than sign and a filename.
    "echo '>' .story/config.json",
    // The CLI writes only where it RUNS. M-CLI-AS-ARGUMENT takes the word
    // wherever it falls, and printing a sentence sweeps the whole ledger.
    "echo storybloq ticket update",
    "printf '%s\\n' storybloq note create",
  ];
  for (const [index, command] of readers.entries()) {
    await h.fire("tool.call", { tool: "Bash", command, tool_use_id: `dir-${index}` });
    await h.tick();
    expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");
  }

  // And the same shapes pointed the other way do sweep.
  await h.fire("tool.call", { tool: "Bash", command: "cp /tmp/x.json .story/tickets/T-099.json", tool_use_id: "dir-in" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");
});

test("sweeps when a move takes a ticket out of the ledger", async () => {
  const h = harness(newFixture());
  await started(h);
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 1");

  // A move out of `.story/` takes a ticket off the board as surely as a move
  // in puts one on, and the board has to lose it in the same turn. A rule
  // that only watches the destination leaves the ticket drawn until the turn
  // ends, which is the staleness the mid-turn scan exists to end.
  delete h.fixture.files[".story/tickets/T-001.json"];
  delete h.fixture.mtimes[".story/tickets/T-001.json"];
  await h.fire("tool.call", { tool: "Bash", command: "mv .story/tickets/T-001.json /tmp/x.json", tool_use_id: "mv-out" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 0");
});

test("sweeps for the CLI writing under a flag that reads like prose", async () => {
  const h = harness(newFixture());
  await started(h);
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  // `create` is the subcommand; the `update` in the quoted content is not a
  // verb and neither decides anything. The write still has to be seen.
  await h.fire("tool.call", {
    tool: "Bash",
    command: 'storybloq note create --content "please update the board"',
    tool_use_id: "b3",
  });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");
});

test("sweeps for a redirect into the ledger, and for a Write at one of its paths", async () => {
  const h = harness(newFixture());
  await started(h);
  h.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "inprogress", order: 10, title: "Open ten" });
  h.fixture.mtimes[".story/tickets/T-010.json"] = 2000;

  await h.fire("tool.call", { tool: "Bash", command: "echo '{}' > .story/tickets/T-099.json", tool_use_id: "b2" });
  await h.tick();
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 2");

  const second = harness(newFixture());
  await started(second);
  second.fixture.files[".story/tickets/T-010.json"] = ticketText({ id: "T-010", status: "complete", order: 10, title: "Open ten" });
  second.fixture.mtimes[".story/tickets/T-010.json"] = 2000;
  await second.fire("tool.call", { tool: "Write", file_path: "/repo/.story/tickets/T-010.json", tool_use_id: "w1" });
  await second.tick();
  expect(headingOf(await second.render(paneEvent()), "board-done")).toBe("Done 3");
});

test("hands the tool result back exactly once", async () => {
  const h = harness(newFixture());
  await started(h);
  const event = { tool: "mcp__storybloq__storybloq_ticket_update", tool_use_id: "call-5" };
  // The harness's next() answers with the event it was handed, so this is
  // both "next was called" and "its value is what the hook returns".
  expect(await h.fire("tool.call", event)).toBe(event);
});

test("draws the board even when the usage call is refused", async () => {
  const h = harness(newFixture());
  // The context fill is telemetry on the header's right. A host that refuses
  // it, or has no such call, must cost that one figure and nothing else:
  // M-USAGE-BLOCKS leaves the read unguarded in session.start, where it
  // rejects after the pane is opened and takes the ledger read, the board and
  // next(e) down with it.
  h.failUsage = true;
  const passed = await h.fire("session.start", START);
  await h.tick();
  const tree = await h.render(paneEvent());

  // The hook still handed the event on.
  expect(passed).toBe(START);
  // The scan ran to the end and the board has the ledger's numbers.
  expect(headingOf(tree, "board-inprogress")).toBe("In progress 1");
  expect(headingOf(tree, "board-open")).toBe("Open 5");
  // And the right of the footer row is simply empty.
  expect(textOf(nodeByKey(tree, "footer"))).not.toContain("context");

  // The refusal does not stop a later refresh either.
  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  h.fixture.mtimes[".story/tickets/T-001.json"] = 2000;
  const passedTurn = await h.fire("turn.complete", {});
  await h.tick();
  expect(passedTurn).toEqual({});
  expect(headingOf(await h.render(paneEvent()), "board-inprogress")).toBe("In progress 0");
});

test("leaves the narrow fallback a single line, board or no board", async () => {
  const h = harness(newFixture());
  await started(h);
  const narrow = textOf(await h.render(abovePromptEvent(80)));
  expect(narrow).toContain("Storybloq:");
  expect(narrow).not.toContain("Blocked");
  expect(narrow.length).toBeLessThanOrEqual(80);
});
