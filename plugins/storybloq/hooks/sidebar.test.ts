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
    ".story/issues/ISS-001.json": issueText({ severity: "critical" }),
    ".story/handovers/2026-01-02-latest.md": "# Latest",
  };
  const mtimes: Record<string, number> = {};
  for (const path of Object.keys(files)) mtimes[path] = 1000;
  return { files, mtimes };
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
  const state = { reads: 0, failNextInvalidate: false, failTimer: false };
  const counters = { timers: 0, storeSets: 0 };

  const elements = {
    Box: (props: Record<string, unknown>) => ({ element: "Box", props }),
    Text: (props: Record<string, unknown>) => ({ element: "Text", props }),
    Button: (props: Record<string, unknown>) => ({ element: "Button", props }),
    Code: (props: Record<string, unknown>) => ({ element: "Code", props }),
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
      usage: async () => ({ context: { window: 200000, tokens: 40000, percent: 20 }, rateLimits: [] }),
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

function paneEvent(columns = 160): unknown {
  return {
    surface: "terminal",
    component: "Pane",
    requestId: "storybloq",
    viewport: { columns, rows: 40 },
    props: { title: "Storybloq", isFocused: false, bodyColumns: columns - 4, placement: "dock" },
  };
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

  const text = textOf(await h.render(paneEvent()));
  expect(text).toContain("Phase One");
  // Two leaves, one in progress; one open issue, at critical.
  expect(text).toContain("1 in progress");
  expect(text).toContain("1 issues");
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
  expect(textOf(await h.render(paneEvent()))).toContain("1 in progress");

  // Someone completes the in-progress ticket. Its mtime moves, which is the
  // only signal the Mod has: serving the cached fields regardless is the
  // M-STALE-CACHE mutant, and it fails right here.
  h.fixture.files[".story/tickets/T-001.json"] = ticketText({ id: "T-001", status: "complete", title: "Working on it" });
  h.fixture.mtimes[".story/tickets/T-001.json"] = 2000;

  await h.fire("turn.complete", {});
  await h.tick();

  expect(textOf(await h.render(paneEvent()))).toContain("0 in progress");
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
  expect(textOf(await h.render(paneEvent()))).toContain("0 in progress");
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
  expect(textOf(await h.render(paneEvent()))).toContain("1 in progress");

  delete h.fixture.files[".story/tickets/T-001.json"];
  await h.fire("turn.complete", {});
  await h.tick();

  expect(textOf(await h.render(paneEvent()))).toContain("0 in progress");
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
  expect(textOf(await h.render(paneEvent()))).toContain("1 in progress");
});
