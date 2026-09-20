/** Terminal Storyfield adapter. Samples the homepage mark into a fixed Braille field.
 * Geometry comes from web/src/components/sections/Hero.tsx (850 by 950 view).
 * The startup wave changes light, never the mark's structure or cell positions.
 */
export const LOGO_DURATION_MS = 2400;
export type LogoCell = { glyph: string; color: string };
type Point = readonly [number, number];
const points: Point[] = [];
function line(a: Point, b: Point): void { points.push(a, b); }
function curve(a: Point, b: Point, c: Point, d: Point): void {
  let last = a;
  for (let i = 1; i <= 32; i++) {
    const t = i / 32, s = 1 - t;
    const next: Point = [s*s*s*a[0]+3*s*s*t*b[0]+3*s*t*t*c[0]+t*t*t*d[0], s*s*s*a[1]+3*s*s*t*b[1]+3*s*t*t*c[1]+t*t*t*d[1]];
    line(last, next); last = next;
  }
}
line([858,315],[520,315]);
curve([520,315],[426,315],[354,386],[354,482]);
curve([354,482],[354,578],[426,648],[518,648]);
line([532,648],[776,648]);
curve([776,648],[862,648],[912,716],[912,798]);
curve([912,798],[912,880],[862,940],[776,940]);
line([776,940],[342,940]);
// Cache the raster once per terminal width. Animation only shades cells.
const lengths: number[] = [];
let totalLength = 0;
for (let i = 0; i < points.length; i += 2) {
  lengths.push(totalLength);
  totalLength += Math.hypot(points[i + 1]![0] - points[i]![0], points[i + 1]![1] - points[i]![1]);
}
function sample(x: number, y: number): number | null {
  if (Math.hypot(x - 342, y - 940) <= 61) return 0;
  if (Math.abs(Math.hypot(x - 921, y - 315) - 62) <= 23) return 1;
  let nearest = Infinity, along = 0;
  for (let i = 0; i < points.length; i += 2) {
    const a = points[i]!, b = points[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
    const distance = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
    if (distance < nearest) {
      nearest = distance;
      along = 1 - (lengths[i / 2]! + t * Math.hypot(dx, dy)) / totalLength;
    }
  }
  return nearest <= 23 ? along : null;
}
const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
type RasterCell = { glyph: string; along: number; metal: number };
const rasters = new Map<number, RasterCell[][]>();
function raster(width: number): RasterCell[][] {
  const cached = rasters.get(width);
  if (cached) return cached;
  const height = Math.round(width * 950 / 850 / 2);
  const result = Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => {
    let mask = 0, along = 0, count = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
      const at = sample(200 + (col * 2 + x + .5) / (width * 2) * 850, 170 + (row * 4 + y + .5) / (height * 4) * 950);
      if (at !== null) { mask |= bits[y]![x]!; along += at; count++; }
    }
    return {
      glyph: mask ? String.fromCharCode(0x2800 + mask) : ' ',
      along: count ? along / count : 0,
      metal: .5 + .5 * Math.sin(col / width * 3.4 + row / height * 2.2),
    };
  }));
  rasters.set(width, result);
  return result;
}

// Fixed geometry and deterministic time make resizing and seeking predictable.
// A single light impulse follows the thread from its solid end to its open ring.
export function logoFrame(columns: number, elapsedMs: number, reducedMotion = false): LogoCell[][] {
  const width = Math.max(8, Math.min(32, Math.floor(Number.isFinite(columns) ? columns : 28)));
  const time = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : LOGO_DURATION_MS;
  const progress = Math.min(1, time / 2050);
  const head = -.15 + 1.45 * (progress * progress * (3 - 2 * progress));
  return raster(width).map(row => row.map(cell => {
    const distance = cell.along - head;
    const pulse = reducedMotion || time >= 2050 ? 0
      : Math.exp(-distance * distance / (distance < 0 ? .022 : .003));
    const base = [155 + cell.metal * 45, 91 + cell.metal * 49, 58 + cell.metal * 40];
    const crest = [255, 235, 199];
    const color = '#' + base.map((v, i) => Math.round(v + (crest[i]! - v) * pulse).toString(16).padStart(2, '0')).join('');
    return { glyph: cell.glyph, color };
  }));
}

/** Fit to the pane body, never to the height of the entire terminal.
 * Inline panes are intentionally short. Docked panes can show a larger mark.
 * Missing initial measurements use a conservative bound until the next render.
 */
export function logoLayout(columns: number, bodyRows: number | undefined, placement: "dock" | "inline" | null): { columns: number; top: number; left: number; rows: number } | null {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const cap = placement === "dock" ? 18 : 9;
  const measured = typeof bodyRows === "number" && Number.isFinite(bodyRows) && bodyRows > 0;
  const room = measured ? Math.min(cap, Math.floor(bodyRows)) : (placement === "dock" ? 14 : 7);
  // One header row, one breathing row, and at least five rows of artwork.
  const available = room - 2;
  const artWidth = Math.min(28, width - 2, Math.floor(available * 850 * 2 / 950));
  if (artWidth < 8) return null;
  const height = Math.round(artWidth * 950 / 850 / 2);
  return { columns: artWidth, left: Math.floor((width - artWidth) / 2), top: 1 + Math.floor((available - height) / 2), rows: height };
}
