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
      usage: async () => state.usage,
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

function paneEvent(columns = 160, bodyRows = 30): unknown {
  return {
    surface: "terminal",
    component: "Pane",
    requestId: "storybloq",
    viewport: { columns, rows: 40 },
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

/** One row per drawn line of a column, heading first. */
function rowsOf(tree: unknown, key: string): string[] {
  const column = nodeByKey(tree, key);
  if (!column) return [];
  const children = column.props?.children;
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

/** Every string in a drawn tree, flattened, so an assertion can look for one. */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    const props = (node as { props?: Record<string, unknown> }).props ?? {};
    return textOf(props["children"]);
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
  // The phase rides in the header now that the summary line is gone.
  expect(text).toContain("Phase: Phase One");
  // One leaf in progress; one open issue, at critical.
  expect(headingOf(tree, "board-inprogress")).toBe("In progress 1");
  expect(text).toContain("1 critical");
  expect(text).toContain("T-001");
  expect(text).toContain("2026-01-02-latest.md");
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

test("draws a board of the current phase, in four columns", async () => {
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

test("shows only the current phase, never another phase's ticket", async () => {
  const h = harness(newFixture());
  await started(h);
  const tree = await h.render(paneEvent());

  // T-002 is the only ticket of phase two. M-PHASE-LEAK lets it through.
  for (const key of ["board-blocked", "board-open", "board-inprogress", "board-done"]) {
    expect(columnText(tree, key)).not.toContain("T-002");
  }
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
  // Sixteen open tickets, of which eight are drawn. The heading still says
  // sixteen: M-COUNT-MISMATCH heads it with the drawn rows instead, and a
  // capped column then under-reports the phase. This is the figure the owner
  // read live, where Done said 27 over eighteen drawn rows.
  expect(headingOf(await h.render(paneEvent()), "board-open")).toBe("Open 16");
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

test("heads the pane with the wordmark and the phase, context to the right", async () => {
  const h = harness(newFixture());
  await started(h);
  await h.fire("turn.complete", {});
  const tree = await h.render(paneEvent());
  const header = textOf(nodeByKey(tree, "header"));

  expect(header).toContain("Storybloq");
  // The board is scoped to one phase and the header is what says which.
  expect(header).toContain("Phase: Phase One");
  expect(header).toContain("context 20%");
  // The owner took the rasterized mark out; the wordmark is the brand.
  expect(nodeByKey(tree, "logo")).toBe(null);
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
  expect(textOf(nodeByKey(await h.render(paneEvent()), "header"))).toContain("context 25%");
});

test("prefers the percent the engine states over its own arithmetic", async () => {
  const h = harness(newFixture());
  await started(h);
  // The engine's own figure counts the window the way the status line does,
  // so where it exists it wins.
  h.usage = { context: { window: 200_000, tokens: 50_000, percent: 73 }, rateLimits: [] };
  await h.fire("turn.complete", {});
  expect(textOf(nodeByKey(await h.render(paneEvent()), "header"))).toContain("context 73%");
});

test("says nothing about context on a window that has had no response yet", async () => {
  const h = harness(newFixture());
  await started(h);
  // A fresh session, or one just compacted: neither figure exists, and a made
  // up zero would read as an empty window rather than an unknown one.
  h.usage = { context: { window: 200_000 }, rateLimits: [] };
  await h.fire("turn.complete", {});
  expect(textOf(nodeByKey(await h.render(paneEvent()), "header"))).not.toContain("context");
});

test("names the two newest handovers, one per line, newest first", async () => {
  const h = harness(newFixture());
  h.fixture.files[".story/handovers/2026-01-03-newest.md"] = "# Newest";
  h.fixture.files[".story/handovers/2026-01-01-oldest.md"] = "# Oldest";
  h.fixture.mtimes[".story/handovers/2026-01-03-newest.md"] = 1000;
  h.fixture.mtimes[".story/handovers/2026-01-01-oldest.md"] = 1000;
  await started(h);

  const text = textOf(await h.render(paneEvent()));
  expect(text).toContain("2026-01-03-newest.md");
  expect(text).toContain("2026-01-02-latest.md");
  expect(text).not.toContain("2026-01-01-oldest.md");
  expect(text.indexOf("2026-01-03-newest.md")).toBeLessThan(text.indexOf("2026-01-02-latest.md"));
});

test("caps a column at eight and ends it with dots", async () => {
  const h = harness(manyOpen(12));
  await started(h);
  // Sixteen open tickets: eight rows and a dotted tail, on any pane height.
  // M-CAP-IGNORED draws all sixteen and writes no tail, which is the column
  // that ran off the bottom of the owner's pane.
  const tree = await h.render(paneEvent());
  const rows = rowsOf(tree, "board-open");

  // One heading, eight cards, one tail.
  expect(rows.length).toBe(10);
  expect(rows[9]).toBe("...");
  expect(rows.slice(1, 9).every((row) => row.startsWith("T-"))).toBe(true);
  expect(columnText(tree, "board-open")).toContain("Open 16");
});

test("leaves a column that fits without a tail", async () => {
  const h = harness(newFixture());
  await started(h);
  // Four open tickets, so nothing is left out and there is nothing to say.
  const rows = rowsOf(await h.render(paneEvent()), "board-open");
  expect(rows.length).toBe(5);
  expect(rows).not.toContain("...");
});

test("leaves the narrow fallback a single line, board or no board", async () => {
  const h = harness(newFixture());
  await started(h);
  const narrow = textOf(await h.render(abovePromptEvent(80)));
  expect(narrow).toContain("Storybloq:");
  expect(narrow).not.toContain("Blocked");
  expect(narrow.length).toBeLessThanOrEqual(80);
});
