import { describe, it, expect } from "vitest";
import { logoFrame, logoLayout } from "../../plugins/storybloq/hooks/storyfield-logo.js";

describe("terminal logo material", () => {
  it("keeps the dot geometry fixed while the wave changes its lighting", () => {
    const a = logoFrame(24, 0), b = logoFrame(24, 900);
    expect(a.map(row => row.map(cell => cell.glyph))).toEqual(b.map(row => row.map(cell => cell.glyph)));
    expect(a).not.toEqual(b);
    expect(a.flat().some(cell => cell.glyph !== " ")).toBe(true);
  });
  it("settles and has a deterministic motion-free composition", () => {
    expect(logoFrame(24, 2400)).toEqual(logoFrame(24, 10000));
    expect(logoFrame(24, 0, true)).toEqual(logoFrame(24, 900, true));
  });
  it("bounds terminal work even for malformed widths", () => {
    for (const width of [0, -10, NaN, Infinity, 100000]) {
      const frame = logoFrame(width, 0);
      expect(frame.length).toBeLessThanOrEqual(18);
      expect(frame[0]!.length).toBeLessThanOrEqual(32);
      expect(frame.flat().every(cell => /^#[0-9a-f]{6}$/.test(cell.color))).toBe(true);
    }
  });
});


describe("responsive logo layout", () => {
  it("fits and centers in measured bottom bars and sidebars", () => {
    for (const placement of ["inline", "dock"] as const) {
      for (const width of [8, 12, 20, 40, 80, 156, 240]) {
        for (const rows of [1, 3, 5, 7, 10, 14, 30, 60]) {
          const layout = logoLayout(width, rows, placement);
          if (!layout) continue;
          const frame = logoFrame(layout.columns, 0);
          expect(1 + layout.top + frame.length).toBeLessThanOrEqual(rows);
          expect(layout.left + layout.columns).toBeLessThanOrEqual(width);
          expect(Math.abs(layout.left - (width - layout.left - layout.columns))).toBeLessThanOrEqual(1);
        }
      }
    }
  });
  it("keeps inline artwork compact and preserves its aspect on resize", () => {
    expect(logoLayout(156, 12, "inline")!.columns).toBeLessThan(logoLayout(40, 30, "dock")!.columns);
    expect(logoLayout(4, 30, "dock")).toBeNull();
    expect(logoLayout(40, 3, "dock")).toBeNull();
    expect(logoLayout(156, undefined, "inline")!.rows).toBeLessThanOrEqual(5);
  });
});
