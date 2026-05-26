import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMergeDriver } from "../../src/cli/commands/merge-driver.js";

function writeTemp(dir: string, name: string, content: Record<string, unknown>): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content, null, 2) + "\n", "utf-8");
  return p;
}

describe("T-387: merge driver routing", () => {
  it("config.json: clean merge returns 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const cfg = { version: 2, project: "test", type: "npm", language: "ts", features: { tickets: true } };
    const base = writeTemp(dir, "base.json", cfg);
    const ours = writeTemp(dir, "ours.json", cfg);
    const theirs = writeTemp(dir, "theirs.json", { ...cfg, language: "javascript" });
    const exit = handleMergeDriver(base, ours, theirs, ".story/config.json");
    expect(exit).toBe(0);
    const merged = JSON.parse(readFileSync(ours, "utf-8"));
    expect(merged.language).toBe("javascript");
  });

  it("config.json: conflict returns 1 with _conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const cfg = { version: 2, project: "test", type: "npm", language: "ts", features: { tickets: true } };
    const base = writeTemp(dir, "base.json", cfg);
    const ours = writeTemp(dir, "ours.json", { ...cfg, project: "alpha" });
    const theirs = writeTemp(dir, "theirs.json", { ...cfg, project: "beta" });
    const exit = handleMergeDriver(base, ours, theirs, ".story/config.json");
    expect(exit).toBe(1);
    const merged = JSON.parse(readFileSync(ours, "utf-8"));
    expect(Array.isArray(merged._conflicts)).toBe(true);
  });

  it("roadmap.json: clean merge returns 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const rm = { title: "proj", date: "2026-01-01", phases: [{ id: "a", label: "A", name: "A", description: "d" }], blockers: [] };
    const base = writeTemp(dir, "base.json", rm);
    const ours = writeTemp(dir, "ours.json", rm);
    const theirs = writeTemp(dir, "theirs.json", { ...rm, title: "updated" });
    const exit = handleMergeDriver(base, ours, theirs, ".story/roadmap.json");
    expect(exit).toBe(0);
    const merged = JSON.parse(readFileSync(ours, "utf-8"));
    expect(merged.title).toBe("updated");
  });

  it("roadmap.json: conflict returns 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const rm = { title: "proj", date: "2026-01-01", phases: [{ id: "a", label: "A", name: "A", description: "d" }], blockers: [] };
    const base = writeTemp(dir, "base.json", rm);
    const ours = writeTemp(dir, "ours.json", { ...rm, title: "alpha" });
    const theirs = writeTemp(dir, "theirs.json", { ...rm, title: "beta" });
    const exit = handleMergeDriver(base, ours, theirs, ".story/roadmap.json");
    expect(exit).toBe(1);
  });

  it("entity file still routes to threeWayMerge", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const ticket = { id: "T-001", title: "Test", description: "", type: "task", status: "open", phase: "p1", order: 10, createdDate: "2026-01-01", blockedBy: [], parentTicket: null, completedDate: null };
    const base = writeTemp(dir, "base.json", ticket);
    const ours = writeTemp(dir, "ours.json", ticket);
    const theirs = writeTemp(dir, "theirs.json", { ...ticket, title: "Updated" });
    const exit = handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json");
    expect(exit).toBe(0);
    const merged = JSON.parse(readFileSync(ours, "utf-8"));
    expect(merged.title).toBe("Updated");
  });

  it("unknown file returns 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const obj = { foo: "bar" };
    const base = writeTemp(dir, "base.json", obj);
    const ours = writeTemp(dir, "ours.json", obj);
    const theirs = writeTemp(dir, "theirs.json", obj);
    const exit = handleMergeDriver(base, ours, theirs, ".story/unknown.json");
    expect(exit).toBe(2);
  });

  it("malformed JSON returns 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const base = join(dir, "base.json");
    const ours = join(dir, "ours.json");
    const theirs = join(dir, "theirs.json");
    writeFileSync(base, "{ invalid json", "utf-8");
    writeFileSync(ours, "{}", "utf-8");
    writeFileSync(theirs, "{}", "utf-8");
    const exit = handleMergeDriver(base, ours, theirs, ".story/config.json");
    expect(exit).toBe(2);
  });
});
