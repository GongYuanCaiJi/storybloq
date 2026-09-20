/**
 * Draws the sidebar Mod's pane for a project directory as text, without a
 * client: the Mod runs against a `$` backed by the real filesystem, and the
 * element tree it returns is laid out with a small text renderer (bordered
 * boxes, rows, columns, truncation by string length).
 *
 *   npx tsx scripts/sidebar-render.ts <project-dir> [more dirs...]
 *   npx tsx scripts/sidebar-render.ts --all [samples-root]
 *
 * Each project is drawn three ways: docked at 40 body columns (the sidebar,
 * stacked), inline at 156 (side by side) and inline at 45 (the narrow strip),
 * on a 50-row viewport. The geometry is an approximation of the client's
 * (wide characters count as one cell here); the content is the Mod's own.
 * Pair with scripts/sidebar-states.ts, which writes the sample projects.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { registerSidebar } from "../plugins/storybloq/hooks/sidebar.ts";

type Handler = ($: any, e: any, next: (e: any) => unknown) => unknown;

interface Node {
  node: "Box" | "Text";
  [key: string]: unknown;
}

function errno(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function makeClient(cwd: string, logs: string[]) {
  const timers: (() => void)[] = [];
  const store = new Map<string, unknown>();
  const abs = (p: string): string => (p.startsWith("/") ? p : join(cwd, p));
  const $ = {
    fs: {
      exists: async (p: string) => {
        // Missing is false; anything else (EACCES, EIO) is the refusal the
        // Mod's root walk has to see, so it is rethrown with its errno.
        try {
          await fs.stat(abs(p));
          return true;
        } catch (e: any) {
          if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return false;
          throw errno(e?.code ?? "EIO", String(e?.message ?? e));
        }
      },
      read: async (p: string) => {
        try {
          return await fs.readFile(abs(p), "utf8");
        } catch (e: any) {
          throw errno(e?.code ?? "EIO", String(e?.message ?? e));
        }
      },
      list: async (p: string) => {
        try {
          const entries = await fs.readdir(abs(p), { withFileTypes: true });
          return entries.map((d) => ({ name: d.name, kind: d.isDirectory() ? "dir" : "file" }));
        } catch (e: any) {
          throw errno(e?.code ?? "EIO", String(e?.message ?? e));
        }
      },
      stat: async (p: string) => {
        try {
          const s = await fs.stat(abs(p));
          return { mtimeMs: s.mtimeMs };
        } catch (e: any) {
          throw errno(e?.code ?? "EIO", String(e?.message ?? e));
        }
      },
      watch: () => () => undefined,
      write: async () => undefined,
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    ui: {
      open: async () => undefined,
      log: (line: string) => void logs.push(line),
      invalidate: () => undefined,
      resolve: () => ({
        Box: (props: any): Node => ({ node: "Box", ...props }),
        Text: (props: any): Node => ({ node: "Text", ...props }),
      }),
    },
    clock: {
      every: (_ms: number, cb: () => void) => {
        timers.push(cb);
        return () => undefined;
      },
    },
    config: { list: async () => [] },
    settings: { read: async () => ({}) },
    session: { usage: async () => ({ context: { window: 200_000, tokens: 36_000, percent: 18 } }) },
  };
  return { $, timers };
}

/** Text of a Text node: its children flattened. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as Node;
  return textOf(n["children"]);
}

function cut(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Lays a node out in `width` cells and returns its rows. */
function layout(node: unknown, width: number): string[] {
  if (node === null || node === undefined || node === false) return [];
  if (Array.isArray(node)) return node.flatMap((child) => layout(child, width));
  const n = node as Node;
  if (n.node === "Text") return [pad(cut(textOf(n), width), width)];
  const children = Array.isArray(n["children"]) ? (n["children"] as unknown[]) : [n["children"]];
  const own = typeof n["width"] === "number" ? Math.min(n["width"] as number, width) : width;
  const bordered = typeof n["borderStyle"] === "string";
  const inner = bordered ? Math.max(1, own - 2) : own;
  let rows: string[];
  if (n["flexDirection"] === "row") {
    const gap = typeof n["gap"] === "number" ? (n["gap"] as number) : 0;
    const kids = children.filter((c) => c !== null && c !== undefined && c !== false);
    const fixed = kids.map((c) => (typeof (c as Node)?.["width"] === "number" ? ((c as Node)["width"] as number) : null));
    const used = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0) + gap * Math.max(0, kids.length - 1);
    const flexible = fixed.filter((w) => w === null).length;
    const share = flexible > 0 ? Math.max(1, Math.floor((inner - used) / flexible)) : 0;
    const columns = kids.map((c, k) => layout(c, fixed[k] ?? share));
    const widths = kids.map((_, k) => fixed[k] ?? share);
    const height = Math.max(0, ...columns.map((c) => c.length));
    rows = [];
    if (n["justifyContent"] === "space-between" && kids.length === 2) {
      const left = columns[0] ?? [];
      const right = columns[1] ?? [];
      for (let r = 0; r < height; r += 1) {
        const l = (left[r] ?? "").trimEnd();
        const rt = (right[r] ?? "").trimEnd();
        rows.push(pad(l + " ".repeat(Math.max(1, inner - l.length - rt.length)) + rt, inner));
      }
    } else {
      for (let r = 0; r < height; r += 1) {
        rows.push(pad(columns.map((c, k) => pad(c[r] ?? "", widths[k]!)).join(" ".repeat(gap)), inner));
      }
    }
  } else {
    rows = children.flatMap((c) => layout(c, inner));
  }
  if (!bordered) return rows.map((r) => pad(cut(r, own), own));
  const top = `┌${"─".repeat(inner)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  return [top, ...rows.map((r) => `│${pad(cut(r, inner), inner)}│`), bottom];
}

async function draw(dir: string): Promise<void> {
  const cwd = resolve(dir);
  const logs: string[] = [];
  const handlers = new Map<string, Handler>();
  const { $, timers } = makeClient(cwd, logs);
  const on = ((event: string, hook: Handler) => {
    handlers.set(event, hook);
    return { catch: () => undefined };
  }) as any;
  registerSidebar(on, {});
  const fire = async (event: string, payload: Record<string, unknown>): Promise<unknown> => {
    const h = handlers.get(event);
    return h === undefined ? undefined : await h($, payload, (e: any) => e);
  };
  await fire("session.start", { surface: "terminal", isInteractive: true, cwd });
  // Real disk reads finish on the event loop, not on a microtask, so each
  // round waits a few milliseconds before the next tick drains more.
  for (let round = 0; round < 300; round += 1) {
    for (const timer of [...timers]) timer();
    await new Promise((r) => setTimeout(r, 4));
  }
  const views: readonly [string, "dock" | "inline", number][] = [
    ["docked sidebar, 40 body columns", "dock", 40],
    ["inline, 156 body columns", "inline", 156],
    ["inline, 45 body columns (narrow strip)", "inline", 45],
  ];
  console.log(`\n${"=".repeat(80)}\n${cwd}\n${"=".repeat(80)}`);
  for (const [label, placement, width] of views) {
    const tree = await fire("ui.render", {
      surface: "terminal",
      component: "Pane",
      requestId: "storybloq",
      viewport: { columns: width + 4, rows: 50 },
      props: { title: "Storybloq", isFocused: false, bodyColumns: width, placement, scroll: { offset: 0, bodyRows: 50 } },
    });
    console.log(`\n--- ${label}`);
    if (tree === undefined || tree === null || (tree as any).component === "Pane") {
      console.log("(no pane drawn)");
    } else {
      for (const row of layout(tree, width)) console.log(`|${row}|`);
    }
  }
  const band = await fire("ui.render", {
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "above-prompt",
    viewport: { columns: 120, rows: 50 },
    props: {},
  });
  console.log(`\n--- band at 120 columns`);
  console.log(band === undefined || (band as any).component === "AbovePrompt" ? "(no band)" : textOf(band));
  if (logs.length > 0) console.log(`\n--- logs\n${logs.join("\n")}`);
}

const args = process.argv.slice(2);
const dirs: string[] = [];
if (args[0] === "--all") {
  const root = args[1] ?? join(homedir(), "Developer", "sidebar-states");
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(join(root, entry.name));
  }
  dirs.sort();
} else {
  dirs.push(...args);
}
if (dirs.length === 0) {
  console.error("usage: npx tsx scripts/sidebar-render.ts <project-dir>... | --all [samples-root]");
  process.exit(2);
}
for (const dir of dirs) await draw(dir);
