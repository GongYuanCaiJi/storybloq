/**
 * ISS-738: repair write mode must apply MINIMAL patches to the on-disk JSON.
 *
 * The old write path re-serialized loader-HYDRATED entities, so every repaired
 * file also absorbed loader-derived fields: observed adding displayId to 145
 * legacy tickets and flipping completedDate (absent -> null) when only the
 * requested ref fixes should have changed. These tests drive the REAL CLI from
 * dist (like merge-driver-e2e), so they require `npm run build` first.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serializeJSON } from "../../../src/core/project-loader.js";

const cliPath = resolve(fileURLToPath(import.meta.url), "../../../../dist/cli.js");

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "repair-e2e-"));
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), serializeJSON({
    version: 2, project: "repair-e2e", type: "npm", language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), serializeJSON({
    title: "repair-e2e", date: "2026-01-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "First." }],
    blockers: [],
  }));
  return dir;
}

function runRepair(dir: string): string {
  return execFileSync("node", [cliPath, "repair"], { cwd: dir, encoding: "utf-8" });
}

describe("ISS-738: repair write mode is a minimal patch, not a loader round-trip", () => {
  it("fixes a stale blockedBy ref WITHOUT injecting displayId or dropping unknown keys", () => {
    const dir = makeProject();
    // Legacy ticket: NO displayId key on disk, carries unknown/future keys.
    const original = {
      id: "T-001",
      title: "Legacy ticket",
      description: "",
      type: "task",
      status: "open",
      phase: "p1",
      order: 10,
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: ["T-999"],
      parentTicket: null,
      customNote: "keep-me",
      futureKey: { nested: true },
    };
    const target = join(dir, ".story", "tickets", "T-001.json");
    writeFileSync(target, serializeJSON(original));

    const output = runRepair(dir);
    expect(output).toContain("Fixed 1 stale reference(s)");

    const after = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
    expect(after.blockedBy).toEqual([]);
    // The heart of ISS-738: loader-derived fields must NOT be injected.
    expect(Object.hasOwn(after, "displayId")).toBe(false);
    // Unknown/future keys on disk survive untouched.
    expect(after.customNote).toBe("keep-me");
    expect(after.futureKey).toEqual({ nested: true });
    // Byte-level: the ONLY change is the patched field (locks completedDate
    // staying null, key order, everything).
    const expected = serializeJSON({ ...original, blockedBy: [] });
    expect(readFileSync(target, "utf-8")).toBe(expected);
  });

  it("strips stale claim keys from a completed ticket without touching anything else", () => {
    const dir = makeProject();
    const original = {
      id: "T-002",
      title: "Done ticket",
      description: "",
      type: "task",
      status: "complete",
      phase: "p1",
      order: 20,
      createdDate: "2026-01-01",
      completedDate: "2026-01-02",
      blockedBy: [],
      parentTicket: null,
      claim: { user: "me@example.com", branch: "main", since: "2026-01-02T00:00:00.000Z" },
      claimedBySession: "0f0f0f0f-0000-4000-8000-000000000000",
      customNote: "keep-me",
    };
    const target = join(dir, ".story", "tickets", "T-002.json");
    writeFileSync(target, serializeJSON(original));

    const output = runRepair(dir);
    expect(output).toContain("Fixed 1 stale reference(s)");

    const after = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
    expect(Object.hasOwn(after, "claim")).toBe(false);
    expect(Object.hasOwn(after, "claimedBySession")).toBe(false);
    expect(Object.hasOwn(after, "displayId")).toBe(false);
    const { claim: _c, claimedBySession: _s, ...rest } = original;
    expect(readFileSync(target, "utf-8")).toBe(serializeJSON(rest));
  });

  it("fixes a stale issue relatedTickets ref with the same minimal-patch guarantee", () => {
    const dir = makeProject();
    const original = {
      id: "ISS-001",
      title: "Legacy issue",
      severity: "low",
      impact: "Some impact.",
      status: "open",
      components: [],
      resolution: null,
      location: [],
      discoveredDate: "2026-01-01",
      resolvedDate: null,
      relatedTickets: ["T-404"],
      updatedAt: "2026-01-01T00:00:00.000Z",
      futureKey: { nested: true },
    };
    const target = join(dir, ".story", "issues", "ISS-001.json");
    writeFileSync(target, serializeJSON(original));

    const output = runRepair(dir);
    expect(output).toContain("Fixed 1 stale reference(s)");

    const after = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
    expect(after.relatedTickets).toEqual([]);
    expect(Object.hasOwn(after, "displayId")).toBe(false);
    expect(after.futureKey).toEqual({ nested: true });
    expect(readFileSync(target, "utf-8")).toBe(serializeJSON({ ...original, relatedTickets: [] }));
  });
});
