/** The cell-width approximation's special code points, and the cut mark. */
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR = 0xfe0f;
const ELLIPSIS = "\u2026";


/**
 * The graphemes of a string with the cells each one takes.
 *
 * One routine, used by both the measuring and the cutting, because two that
 * disagree is how "👩‍💻abc" cut to four cells came apart in the middle of the
 * emoji: the measure suppressed the code point after the zero-width joiner
 * and the cut counted it again. `Intl.Segmenter` gives the clusters (this
 * runtime has it; where it does not, the fallback is code points, which is
 * the old behaviour and no worse). A cluster is two cells wide if any code
 * point in it is wide, or if it carries the emoji variation selector, which
 * is what makes a text glyph like "♥️" render double.
 */
export function graphemes(text: string): { cluster: string; cells: number }[] {
  const out: { cluster: string; cells: number }[] = [];
  for (const cluster of clustersOf(text)) {
    let cells = 0;
    let emoji = false;
    for (const character of cluster) {
      const point = character.codePointAt(0) ?? 0;
      if (point === VARIATION_SELECTOR) emoji = true;
      if (isCombining(point) || point === VARIATION_SELECTOR || point === ZERO_WIDTH_JOINER) continue;
      cells = Math.max(cells, isWide(point) ? 2 : 1);
    }
    out.push({ cluster, cells: emoji ? 2 : Math.max(cells, cluster === "" ? 0 : 1) });
  }
  return out;
}

/** Grapheme clusters where the runtime has them, code points where it does not. */
function clustersOf(text: string): string[] {
  const segmenter = (Intl as unknown as { Segmenter?: any }).Segmenter;
  if (typeof segmenter === "function") {
    const out: string[] = [];
    for (const part of new segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      out.push(part.segment as string);
    }
    return out;
  }
  return [...text];
}

/**
 * How many terminal cells a string takes, which is not its length.
 *
 * A CJK ideograph or an emoji occupies two cells and a combining mark none,
 * so measuring `.length` overruns a column by a cell per wide character, the
 * row wraps, and the board comes apart. This is the usual approximation (the
 * East Asian Wide and Fullwidth blocks plus the emoji planes), not a full
 * Unicode width table, which is more than a sidebar can carry.
 */
export function cellWidth(text: string): number {
  let width = 0;
  for (const { cells } of graphemes(text)) width += cells;
  return width;
}

function isCombining(point: number): boolean {
  return (
    (point >= 0x0300 && point <= 0x036f)
    || (point >= 0x0483 && point <= 0x0489)
    || (point >= 0x0591 && point <= 0x05bd)
    || (point >= 0x0610 && point <= 0x061a)
    || (point >= 0x064b && point <= 0x065f)
    || (point >= 0x1ab0 && point <= 0x1aff)
    || (point >= 0x1dc0 && point <= 0x1dff)
    || (point >= 0x20d0 && point <= 0x20ff)
    || (point >= 0xfe20 && point <= 0xfe2f)
  );
}

function isWide(point: number): boolean {
  return (
    (point >= 0x1100 && point <= 0x115f)
    || (point >= 0x2e80 && point <= 0x303e)
    || (point >= 0x3041 && point <= 0x33ff)
    || (point >= 0x3400 && point <= 0x4dbf)
    || (point >= 0x4e00 && point <= 0x9fff)
    || (point >= 0xa000 && point <= 0xa4cf)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1f64f)
    || (point >= 0x1f680 && point <= 0x1f6ff)
    || (point >= 0x1f900 && point <= 0x1f9ff)
    || (point >= 0x20000 && point <= 0x3fffd)
  );
}

/**
 * Cuts a string to fit `cells` terminal cells, ending in one ellipsis where
 * anything was cut.
 *
 * Cluster by cluster, on the same measure the width uses, so a family emoji
 * or an accented letter is either wholly in or wholly out and never halved.
 * The ellipsis is U+2026, one cell wide.
 */
export function truncate(text: string, cells: number): string {
  if (cells <= 0) return "";
  const parts = graphemes(text);
  let total = 0;
  for (const part of parts) total += part.cells;
  if (total <= cells) return text;
  const room = cells - 1;
  let width = 0;
  let out = "";
  for (const part of parts) {
    if (width + part.cells > room) break;
    width += part.cells;
    out += part.cluster;
  }
  return `${out}${ELLIPSIS}`;
}
