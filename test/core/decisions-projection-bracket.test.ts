/**
 * T-528: the loader bracket. The shipped loaders parse the rulings and the
 * catalogs before the capture enumerates its inputs, so an input added,
 * removed or created in between would leave parsed data that the entries (and
 * the revision) do not describe, and pass 2, reading the later state, would
 * agree with the entries. The capture must call itself inconsistent and be
 * retried. Changes are injected by wrapping `readdirSafe`: the capture's first
 * listing of `issues/` comes after the loaders ran and before the enumeration
 * lists `rulings/`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type Hook = { dir: string; call: number; when: "pre" | "post"; act: () => void };
const hooks: Hook[] = [];
const calls = new Map<string, number>();

vi.mock("../../src/core/readdir-safe.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/readdir-safe.js")>();
  return {
    ...real,
    readdirSafe: (dir: string) => {
      const n = (calls.get(dir) ?? 0) + 1;
      calls.set(dir, n);
      const due = (when: Hook["when"]) => {
        for (const h of hooks) if (h.dir === dir && h.call === n && h.when === when) h.act();
      };
      due("pre");
      const result = real.readdirSafe(dir);
      due("post");
      return result;
    },
  };
});

const { capturePass, computeDecisionsProjection } = await import("../../src/core/decisions-projection.js");
const { buildSyntheticLedger, SYN } = await import("../../scripts/projection-fixtures.js");
const { capabilityCatalog } = await import("../../src/cli/commands/capability.js");
const { glossaryCatalog } = await import("../../src/core/glossary.js");
const { checkCapabilities } = await import("../../src/core/capability.js");

const catalogs = { capabilities: capabilityCatalog, glossary: glossaryCatalog };
const roots: string[] = [];
afterEach(() => {
  hooks.length = 0;
  calls.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { root: string; story: string } {
  const root = mkdtempSync(join(tmpdir(), "projection-bracket-"));
  roots.push(root);
  buildSyntheticLedger(root, { pointer: false, unreadable: false });
  return { root, story: join(root, ".story") };
}

/** Run `act` when the capture first lists `issues/`: after the loaders, before the enumeration reaches `rulings/`. */
function afterLoaders(story: string, act: () => void): void {
  hooks.push({ dir: join(story, "issues"), call: 1, when: "pre", act });
}

describe("the loader bracket", () => {
  it("an untouched ledger captures consistent", () => {
    const { root } = setup();
    expect(capturePass(root, catalogs).consistent).toBe(true);
  });

  it("a ruling removed after the loader parsed it makes the capture inconsistent", () => {
    const { root, story } = setup();
    afterLoaders(story, () => unlinkSync(join(story, "rulings", `${SYN.current}.json`)));
    const capture = capturePass(root, catalogs);
    expect(capture.rulingsScan.rulings.map((r) => r.id)).toContain(SYN.current);
    expect(capture.consistent).toBe(false);
  });

  it("a ruling added after the loaders ran makes the capture inconsistent", () => {
    const { root, story } = setup();
    afterLoaders(story, () => copyFileSync(join(story, "rulings", `${SYN.current}.json`), join(story, "rulings", "r-added.json")));
    const capture = capturePass(root, catalogs);
    expect(capture.entries.map((e) => e.path)).toContain("rulings/r-added.json");
    expect(capture.consistent).toBe(false);
  });

  it("a ruling added before the loader listed it and removed before the enumeration makes the capture inconsistent", () => {
    const { root, story } = setup();
    const added = join(story, "rulings", "r-transient.json");
    // Listing 1 of rulings/ is the bracket's; listing 2 is the loader's.
    hooks.push({ dir: join(story, "rulings"), call: 2, when: "pre", act: () => copyFileSync(join(story, "rulings", `${SYN.current}.json`), added) });
    afterLoaders(story, () => unlinkSync(added));
    const capture = capturePass(root, catalogs);
    expect(capture.entries.map((e) => e.path)).not.toContain(`rulings/${basename(added)}`);
    expect(capture.consistent).toBe(false);
  });

  it("a catalog created after its loader found it absent makes the capture inconsistent", () => {
    const { root, story } = setup();
    const glossary = join(story, "glossary.json");
    const bytes = JSON.stringify({ version: 1, terms: [] });
    unlinkSync(glossary);
    afterLoaders(story, () => writeFileSync(glossary, bytes));
    const capture = capturePass(root, catalogs);
    expect(capture.glossary).toMatchObject({ kind: "ok", present: false });
    expect(capture.consistent).toBe(false);
  });

  it("an inconsistent capture is retried rather than written", async () => {
    const { root, story } = setup();
    afterLoaders(story, () => unlinkSync(join(story, "rulings", `${SYN.current}.json`)));
    let passes = 0;
    const { projection } = await computeDecisionsProjection(
      root,
      catalogs,
      "structural",
      {
        now: () => new Date(0),
        cliVersion: "test",
        headCommit: async () => null,
        check: (e, s, o) => checkCapabilities(root, e, s, { ...o, skipFreshness: true }),
        upwardBoard: () => undefined,
      },
      { betweenPasses: () => void (passes += 1) },
    );
    expect(passes).toBe(2);
    const rulings = (projection as { rulings: { id: string }[] }).rulings.map((r) => r.id);
    expect(rulings).not.toContain(SYN.current);
  });
});
