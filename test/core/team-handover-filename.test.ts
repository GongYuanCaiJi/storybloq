import { describe, it, expect } from "vitest";
import { generateTeamHandoverFilename } from "../../src/core/handover-filename.js";

describe("T-380: team handover filename", () => {
  it("has HHMMSS format after date", () => {
    const name = generateTeamHandoverFilename("session");
    const match = name.match(/^\d{4}-\d{2}-\d{2}-(\d{6})-/);
    expect(match).not.toBeNull();
  });

  it("has 8-char hex suffix", () => {
    const name = generateTeamHandoverFilename("session");
    const match = name.match(/^\d{4}-\d{2}-\d{2}-\d{6}-([0-9a-f]{8})-/);
    expect(match).not.toBeNull();
  });

  it("preserves slug", () => {
    const name = generateTeamHandoverFilename("my-slug");
    expect(name).toContain("-my-slug.md");
  });

  it("ends with .md", () => {
    const name = generateTeamHandoverFilename("test");
    expect(name.endsWith(".md")).toBe(true);
  });

  it("is unique across multiple calls", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateTeamHandoverFilename("session"));
    }
    expect(names.size).toBe(20);
  });

  it("uses UTC date (date portion matches UTC)", () => {
    const name = generateTeamHandoverFilename("test");
    const now = new Date();
    const utcDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    expect(name.startsWith(utcDate)).toBe(true);
  });
});
