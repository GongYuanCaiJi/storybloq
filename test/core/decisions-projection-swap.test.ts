/**
 * T-528: a listed directory replaced by a symlink to somewhere outside the
 * ledger after it was listed and before its entries are read, and left
 * replaced. Containment alone cannot see it (the realpaths of the directory
 * and the file agree once both point outside), so the directory identity
 * checkpoint is what keeps outside bytes out of the revision. Kept in its own
 * file because the swap is injected by wrapping `readdirSafe`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const swap: { dir: string | null; outside: string | null } = { dir: null, outside: null };

vi.mock("../../src/core/readdir-safe.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/readdir-safe.js")>();
  return {
    ...real,
    readdirSafe: (dir: string) => {
      const result = real.readdirSafe(dir);
      if (swap.dir !== null && dir === swap.dir && swap.outside !== null) {
        renameSync(dir, `${dir}.listed`);
        symlinkSync(swap.outside, dir);
        swap.dir = null;
      }
      return result;
    },
  };
});

const { hashPass, ledgerRevision, computeDecisionsProjection } = await import("../../src/core/decisions-projection.js");
const { buildSyntheticLedger } = await import("../../scripts/projection-fixtures.js");
const { capabilityCatalog } = await import("../../src/cli/commands/capability.js");
const { glossaryCatalog } = await import("../../src/core/glossary.js");
const { checkCapabilities } = await import("../../src/core/capability.js");

const roots: string[] = [];
afterEach(() => {
  swap.dir = null;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { root: string; tickets: string } {
  const root = mkdtempSync(join(tmpdir(), "projection-swap-"));
  roots.push(root);
  buildSyntheticLedger(root, { pointer: false, unreadable: false });
  const tickets = join(root, ".story", "tickets");
  // The outside copy has the same names, so a follow-the-symlink read would succeed.
  swap.outside = join(root, "outside-tickets");
  cpSync(tickets, swap.outside, { recursive: true });
  return { root, tickets };
}

describe("a directory replaced between listing and reading", () => {
  it("hashPass records every entry of it unreadable, and the revision is null", () => {
    const { root, tickets } = setup();
    swap.dir = tickets;
    const entries = hashPass(root);
    expect(entries.find((e) => e.path === "tickets/T-1.json")?.state.kind).toBe("unreadable");
    expect(entries.find((e) => e.path === "tickets/")?.state.kind).toBe("unreadable");
    expect(entries.filter((e) => e.path.startsWith("tickets/")).every((e) => e.state.kind === "unreadable")).toBe(true);
    expect(ledgerRevision(entries)).toBeNull();
  });

  it("the capture keeps nothing read from it and names it in diagnostics", async () => {
    const { root, tickets } = setup();
    swap.dir = tickets;
    const { projection, revision } = await computeDecisionsProjection(
      root,
      { capabilities: capabilityCatalog, glossary: glossaryCatalog },
      "structural",
      {
        now: () => new Date(0),
        cliVersion: "test",
        headCommit: async () => null,
        check: (e, s, o) => checkCapabilities(root, e, s, { ...o, skipFreshness: true }),
        upwardBoard: () => undefined,
      },
    );
    expect(revision).toBeNull();
    const p = projection as { diagnostics: { file: string }[]; rulings: { citedBy: string[] }[] };
    expect(p.diagnostics.map((d) => d.file)).toContain("tickets/");
    expect(p.rulings.flatMap((r) => r.citedBy)).not.toContain("T-1");
  });

  it("a swap that reverts before the rehash still forces a retry: the capture refuses what it read through it", async () => {
    const { root, tickets } = setup();
    swap.dir = tickets;
    let passes = 0;
    const { revision } = await computeDecisionsProjection(
      root,
      { capabilities: capabilityCatalog, glossary: glossaryCatalog },
      "structural",
      {
        now: () => new Date(0),
        cliVersion: "test",
        headCommit: async () => null,
        check: (e, s, o) => checkCapabilities(root, e, s, { ...o, skipFreshness: true }),
        upwardBoard: () => undefined,
      },
      {
        betweenPasses: () => {
          passes += 1;
          if (passes === 1) {
            unlinkSync(tickets);
            renameSync(`${tickets}.listed`, tickets);
          }
        },
      },
    );
    // The outside copy is byte-identical, so only the identity checkpoint tells the two reads apart.
    expect(passes).toBe(2);
    expect(revision).toBe(ledgerRevision(hashPass(root)));
  });
});
