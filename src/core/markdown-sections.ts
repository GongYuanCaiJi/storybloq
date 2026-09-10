export type Disposition =
  | "continuation"
  | "blocked"
  | "owner-gated"
  | "carried"
  | "unclassified";

export type SectionKind = "item" | "decision";

export interface SectionRecord {
  id: string | null;
  label: string;
  disposition: Disposition;
  rationale: string;
  kind: SectionKind;
  file: string;
}

export interface ContinuationIndex {
  omittedCount: number;
  ids: string[];
  file: string;
}

export type TrajectoryDisposition =
  | "continuation"
  | "blocked"
  | "owner-gated"
  | "carried"
  | "shipped";

export interface IdOccurrence {
  id: string;
  disposition: TrajectoryDisposition;
}

export interface ParsedHandover {
  records: SectionRecord[];
  shippedIds: string[];
  unclassifiedFallback: boolean;
  // Every id-bearing occurrence (classified records plus shipped ids), in
  // DOCUMENT ORDER. This is what lets buildTrajectory resolve a same-
  // handover tie (e.g. a shipped mention and a continuation mention of the
  // same id in one handover) by whichever occurs textually first, per the
  // plan -- a plain records[] + shippedIds[] pair loses that ordering.
  orderedIdOccurrences: IdOccurrence[];
}

export interface TrajectoryEntry {
  id: string;
  occurrenceCount: number;
  firstSeenInWindow: string;
  latest: string;
  latestDisposition: TrajectoryDisposition;
}

export interface TrajectoryHandoverInput {
  filename: string;
  orderedIdOccurrences: IdOccurrence[];
}

const CAP_BYTES = 1600;
const CAP_RECORDS = 12;
const RESERVE_MIN_COUNT = 4;
const RESERVE_MIN_BYTES = 480;
const LABEL_MAX_BYTES = 120;
const RATIONALE_MAX_BYTES = 240;
const INDEX_NON_FILE_MAX_BYTES = 160;
const INDEX_MAX_IDS = 20;

const ID_TOKEN_REGEX = /\b(?:T|ISS|N|L)-\d+\b/;

const DECISION_CUE_TOKENS = [
  "decided",
  "ruled",
  "deferred",
  "abandoned",
  "instead",
  "because",
  "owner",
  "do not",
  "never",
  "superseded",
];

const DELIMITER_WORDS = new Set([
  "for",
  "before",
  "in",
  "on",
  "only",
  "to",
  "ranked",
  "after",
]);

interface CategoryToken {
  token: string;
  category: Disposition | "shipped";
}

const CATEGORY_TOKENS: CategoryToken[] = (
  [
    { token: "worker state", category: "continuation" },
    { token: "exact next step", category: "continuation" },
    { token: "next", category: "continuation" },
    { token: "remaining", category: "continuation" },
    { token: "todo", category: "continuation" },
    { token: "open", category: "continuation" },
    { token: "queue", category: "continuation" },
    { token: "blocked", category: "blocked" },
    { token: "owner-open", category: "owner-gated" },
    { token: "owner rulings", category: "owner-gated" },
    { token: "decisions pending", category: "owner-gated" },
    { token: "shipped", category: "shipped" },
    { token: "done", category: "shipped" },
    { token: "completed", category: "shipped" },
    { token: "landed", category: "shipped" },
    { token: "carried forward", category: "carried" },
  ] satisfies CategoryToken[]
).sort((a, b) => b.token.length - a.token.length);

// ---------------------------------------------------------------------------
// Byte-safe truncation
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function truncateUtf8(s: string, maxBytes: number, ellipsis = "..."): string {
  if (byteLength(s) <= maxBytes) return s;
  const ellipsisBytes = byteLength(ellipsis);
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = byteLength(ch);
    if (bytes + chBytes > budget) break;
    out += ch;
    bytes += chBytes;
  }
  return out + ellipsis;
}

// ---------------------------------------------------------------------------
// Heading grammar
// ---------------------------------------------------------------------------

function normalizeHeading(heading: string): string {
  return heading.normalize("NFKC").toLowerCase();
}

function isWordChar(ch: string): boolean {
  return /[a-z0-9-]/.test(ch);
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

function skipWhitespace(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && isWhitespaceChar(s[i] as string)) i++;
  return i;
}

/**
 * `--` counts as the delimiter character at `pos` even though a single `-`
 * is itself a word character -- it is never absorbed into a word.
 */
function isDelimiterCharAt(s: string, pos: number): boolean {
  const ch = s[pos];
  if (ch === undefined) return false;
  if (ch === ":" || ch === "," || ch === "(") return true;
  return ch === "-" && s[pos + 1] === "-";
}

/**
 * Reads one word (a maximal run of letters/digits/hyphens) starting at
 * `pos`, stopping early at a `--` run so it is never absorbed into the
 * word. Returns null if `pos` is not the start of a word (e.g. an
 * unsupported punctuation character) -- this is what makes an input like
 * "Next !!!" fail to classify instead of being silently treated as if the
 * heading ended there.
 */
function readWordAt(s: string, pos: number): { word: string; nextPos: number } | null {
  let i = pos;
  let word = "";
  while (i < s.length) {
    if (s[i] === "-" && s[i + 1] === "-") break;
    const ch = s[i] as string;
    if (!isWordChar(ch)) break;
    word += ch;
    i++;
  }
  return word.length > 0 ? { word, nextPos: i } : null;
}

export function classifyHeading(rawHeading: string): Disposition | "shipped" | null {
  const normalized = normalizeHeading(rawHeading.trim());
  if (!normalized) return null;

  for (const { token, category } of CATEGORY_TOKENS) {
    if (!normalized.startsWith(token)) continue;
    const afterTokenIdx = token.length;
    if (afterTokenIdx > normalized.length) continue;

    const remainder = normalized.slice(afterTokenIdx);
    const boundaryOk =
      remainder.length === 0 ||
      /^\s/.test(remainder) ||
      /^[:,(]/.test(remainder) ||
      remainder.startsWith("--");
    if (!boundaryOk) continue;

    if (remainder.length === 0) return category;

    if (classifyRemainder(remainder)) return category;
  }

  return null;
}

/**
 * remainder is everything in the normalized heading after the category
 * token (already known to start at a valid boundary: whitespace, a
 * delimiter character, "--", or end-of-string). Parses it POSITIONALLY --
 * consume separators, recognize an immediate delimiter or delimiter word,
 * otherwise consume exactly one content word and require end-of-heading or
 * a delimiter at the position right after it. A delimiter character must
 * be found at its actual position; punctuation that never resolves to a
 * word or a delimiter (e.g. "!!!") fails the grammar outright rather than
 * being treated as if nothing followed the token.
 */
function classifyRemainder(remainder: string): boolean {
  let pos = skipWhitespace(remainder, 0);
  if (pos >= remainder.length) return true;
  if (isDelimiterCharAt(remainder, pos)) return true;

  const word1 = readWordAt(remainder, pos);
  if (word1 === null) return false;
  if (DELIMITER_WORDS.has(word1.word.toLowerCase())) return true;

  pos = skipWhitespace(remainder, word1.nextPos);
  if (pos >= remainder.length) return true;
  if (isDelimiterCharAt(remainder, pos)) return true;

  const word2 = readWordAt(remainder, pos);
  if (word2 === null) return false;
  if (DELIMITER_WORDS.has(word2.word.toLowerCase())) return true;

  // A second non-delimiter word exceeds the one-word allowance.
  return false;
}

// ---------------------------------------------------------------------------
// Fence-aware, heading-level section splitting
// ---------------------------------------------------------------------------

interface RawSection {
  level: number;
  heading: string;
  bodyLines: string[];
}

function markFenceLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const stripped = line.replace(/^ {0,3}/, "");
    const match = /^(`{3,}|~{3,})/.exec(stripped);
    const fenceRun = match?.[1];
    if (fenceChar === null) {
      if (fenceRun) {
        fenceChar = fenceRun[0] as string;
        fenceLen = fenceRun.length;
        inFence[i] = true;
        continue;
      }
      inFence[i] = false;
    } else {
      inFence[i] = true;
      if (
        fenceRun &&
        fenceRun[0] === fenceChar &&
        fenceRun.length >= fenceLen &&
        stripped.slice(fenceRun.length).trim() === ""
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  return inFence;
}

function matchAtxHeading(line: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  const level = (m[1] as string).length;
  let text = (m[2] ?? "").trim();
  text = text.replace(/\s+#+\s*$/, "").trim();
  return { level, text };
}

export function splitFenceAwareSections(markdown: string): RawSection[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const inFence = markFenceLines(lines);

  const root: RawSection = { level: 0, heading: "", bodyLines: [] };
  const sections: RawSection[] = [root];
  const stack: RawSection[] = [root];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!inFence[i]) {
      const heading = matchAtxHeading(line);
      if (heading) {
        while (stack.length) {
          const top = stack[stack.length - 1] as RawSection;
          if (top.level < heading.level) break;
          stack.pop();
        }
        const section: RawSection = {
          level: heading.level,
          heading: heading.text,
          bodyLines: [],
        };
        sections.push(section);
        stack.push(section);
        continue;
      }
    }
    (stack[stack.length - 1] as RawSection).bodyLines.push(line);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Bullet / record extraction
// ---------------------------------------------------------------------------

interface RawBullet {
  firstLine: string;
  nestedNonFenceLines: string[];
  hasNestedFence: boolean;
}

const BULLET_MARKER_REGEX = /^( {0,3})[-*+][ \t]+(.*)$/;

function extractBullets(bodyLines: string[]): RawBullet[] {
  const bullets: RawBullet[] = [];
  const inFence = markFenceLines(bodyLines);
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i] as string;
    if (!inFence[i]) {
      const m = BULLET_MARKER_REGEX.exec(line);
      if (m) {
        const markerIndent = (m[1] as string).length;
        const firstLine = m[2] as string;
        const nested: string[] = [];
        let sawFence = false;
        let j = i + 1;
        while (j < bodyLines.length) {
          const next = bodyLines[j] as string;
          if (next.trim() === "") {
            nested.push(next);
            j++;
            continue;
          }
          const nextIndentMatch = /^( *)/.exec(next);
          const nextIndent = nextIndentMatch ? (nextIndentMatch[1] as string).length : 0;
          if (nextIndent <= markerIndent) break;
          if (inFence[j]) {
            sawFence = true;
          } else {
            nested.push(next);
          }
          j++;
        }
        bullets.push({
          firstLine,
          nestedNonFenceLines: nested.filter((l) => l.trim() !== ""),
          hasNestedFence: sawFence,
        });
        i = j;
        continue;
      }
    }
    i++;
  }
  return bullets;
}

function extractIdToken(text: string): string | null {
  const m = ID_TOKEN_REGEX.exec(text);
  return m ? m[0] : null;
}

function computeLabelSource(firstLine: string, id: string | null): string {
  if (id === null) return firstLine.trim();
  const idx = firstLine.indexOf(id);
  if (idx === -1) return firstLine.trim();
  const after = firstLine.slice(idx + id.length);
  return after.replace(/^[\s:,\-.)]+/, "");
}

function findLabelDelimiter(labelSource: string): number | null {
  let bestIdx: number | null = null;
  let bytesBefore = 0;
  let charIdx = 0;
  const chars = Array.from(labelSource);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (bytesBefore >= LABEL_MAX_BYTES) break;
    if (ch === ":") {
      bestIdx = charIdx;
      break;
    }
    if (ch === "-" && chars[i + 1] === "-") {
      bestIdx = charIdx;
      break;
    }
    bytesBefore += byteLength(ch);
    charIdx += ch.length;
  }
  return bestIdx;
}

function computeLabelAndRemainder(labelSource: string): {
  label: string;
  remainder: string | null;
} {
  const delimiterIdx = findLabelDelimiter(labelSource);
  if (delimiterIdx !== null) {
    const label = labelSource.slice(0, delimiterIdx).trimEnd();
    const isDoubleHyphen = labelSource.slice(delimiterIdx, delimiterIdx + 2) === "--";
    const afterDelimiter = labelSource.slice(delimiterIdx + (isDoubleHyphen ? 2 : 1));
    return { label: truncateUtf8(label, LABEL_MAX_BYTES), remainder: afterDelimiter.trim() };
  }
  return {
    label: truncateUtf8(labelSource.trim(), LABEL_MAX_BYTES),
    remainder: null,
  };
}

function computeRationale(remainder: string | null, bullet: RawBullet): string {
  if (remainder !== null && remainder.length > 0) {
    const m = /[.!?] /.exec(remainder);
    const cut = m ? remainder.slice(0, m.index + 1) : remainder;
    return truncateUtf8(cut.trim(), RATIONALE_MAX_BYTES);
  }
  const firstNestedLine = bullet.nestedNonFenceLines[0];
  if (firstNestedLine !== undefined) {
    const firstNested = firstNestedLine.trim();
    if (firstNested) return truncateUtf8(firstNested, RATIONALE_MAX_BYTES);
  }
  return "unknown";
}

function containsCueToken(text: string): boolean {
  const lower = text.toLowerCase();
  return DECISION_CUE_TOKENS.some((token) => lower.includes(token));
}

function buildRecordFromBullet(
  bullet: RawBullet,
  disposition: Disposition,
  file: string,
): SectionRecord {
  const id = extractIdToken(bullet.firstLine);
  const labelSource = computeLabelSource(bullet.firstLine, id);
  const { label, remainder } = computeLabelAndRemainder(labelSource);
  const rationale = computeRationale(remainder, bullet);
  const kind: SectionKind =
    id === null && containsCueToken(bullet.firstLine) ? "decision" : "item";
  return { id, label, disposition, rationale, kind, file };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export function parseHandoverMarkdown(
  markdown: string,
  file: string,
): ParsedHandover {
  const sections = splitFenceAwareSections(markdown);
  const records: SectionRecord[] = [];
  const shippedIds: string[] = [];
  const orderedIdOccurrences: IdOccurrence[] = [];

  let anyClassified = false;

  for (const section of sections) {
    if (section.level === 0) continue;
    const category = classifyHeading(section.heading);
    if (category === null) continue;
    anyClassified = true;

    const bullets = extractBullets(section.bodyLines);
    if (category === "shipped") {
      for (const bullet of bullets) {
        const id = extractIdToken(bullet.firstLine);
        if (id) {
          shippedIds.push(id);
          orderedIdOccurrences.push({ id, disposition: "shipped" });
        }
      }
      continue;
    }

    for (const bullet of bullets) {
      const record = buildRecordFromBullet(bullet, category, file);
      records.push(record);
      if (record.id !== null) {
        // `category` here is never "unclassified" in practice -- that
        // disposition is only ever produced by buildUnclassifiedFallback,
        // not by classifyHeading -- so this narrows safely to the
        // trajectory-relevant subset of Disposition.
        orderedIdOccurrences.push({ id: record.id, disposition: category as TrajectoryDisposition });
      }
    }
  }

  if (anyClassified) {
    return { records, shippedIds, unclassifiedFallback: false, orderedIdOccurrences };
  }

  const fallback = buildUnclassifiedFallback(sections, file);
  return {
    records: fallback ? [fallback] : [],
    shippedIds,
    unclassifiedFallback: true,
    orderedIdOccurrences: [],
  };
}

function buildUnclassifiedFallback(
  sections: RawSection[],
  file: string,
): SectionRecord | null {
  // The root (level 0) section holds content before the first heading, and
  // the first real heading is typically the document title (H1); its
  // bodyLines hold the first paragraph after the title.
  const root = sections.find((s) => s.level === 0);
  const title = sections.find((s) => s.level >= 1);
  const candidateLines = title ? title.bodyLines : root?.bodyLines ?? [];

  const paragraphLines: string[] = [];
  for (const line of candidateLines) {
    if (line.trim() === "") {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (/^ {0,3}[-*+][ \t]+/.test(line)) break;
    paragraphLines.push(line);
  }
  if (paragraphLines.length === 0) return null;

  const bullet: RawBullet = {
    firstLine: paragraphLines.join(" ").trim(),
    nestedNonFenceLines: [],
    hasNestedFence: false,
  };
  const record = buildRecordFromBullet(bullet, "unclassified", file);
  return record;
}

// ---------------------------------------------------------------------------
// Byte-budget selection
// ---------------------------------------------------------------------------

function recordBytes(record: SectionRecord): number {
  return byteLength(JSON.stringify(record));
}

/**
 * The bound this module promises is on the ACTUAL final serialized form the
 * caller receives -- array brackets, commas, and property names included --
 * not a sum of independently-stringified pieces (round-1 code review finding:
 * byte-budget).
 */
function fitsEnvelope(records: SectionRecord[], index: ContinuationIndex | null): boolean {
  return byteLength(JSON.stringify({ records, index })) <= CAP_BYTES;
}

/**
 * Binary search for the LONGEST UTF-8-safe label prefix (via `truncateUtf8`,
 * so the ellipsis marker and JSON escaping are already reflected in the
 * real serialized size `fitsEnvelope` measures) whose envelope fits the
 * remaining budget -- not a fixed shrink target (round-2 code review
 * finding: record-selection -- a fixed target rejects a record that could
 * still fit with further truncation, and can end the reserve pass
 * prematurely). `truncateUtf8(label, n)` is monotonic non-decreasing in
 * `n`, which is what makes the search valid. Returns null only when even
 * the minimal (fully truncated) label does not fit.
 */
function shrinkLabelToFit(
  selected: SectionRecord[],
  record: SectionRecord,
): SectionRecord | null {
  let lo = 0;
  let hi = byteLength(record.label);
  let best: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const label = truncateUtf8(record.label, mid);
    if (fitsEnvelope([...selected, { ...record, label }], null)) {
      best = label;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best === null ? null : { ...record, label: best };
}

/**
 * Tries to add `candidate` to the already-committed `selected` array,
 * shrinking it (rationale, then label, per the plan's ordering) until it
 * fits the real envelope or every shrink stage has been exhausted. Returns
 * the record actually to add, or null if the candidate cannot be admitted
 * (cap already full, or not even a minimally-shrunk form fits).
 */
function tryAdmit(selected: SectionRecord[], candidate: SectionRecord): SectionRecord | null {
  if (selected.length + 1 > CAP_RECORDS) return null;

  if (fitsEnvelope([...selected, candidate], null)) return candidate;

  const rationaleDropped =
    candidate.rationale === "unknown" ? candidate : { ...candidate, rationale: "unknown" };
  if (fitsEnvelope([...selected, rationaleDropped], null)) return rationaleDropped;

  return shrinkLabelToFit(selected, rationaleDropped);
}

export function selectBoundedRecords(
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: ContinuationIndex | null } {
  const selected: SectionRecord[] = [];
  // Parallel to `selected`: the ORIGINAL candidate index each entry came
  // from, tracked explicitly rather than by object identity (round-1 code
  // review finding: omission-accounting -- a shrunk record is a new object,
  // so identity-based omission detection double-counted it).
  const selectedOriginalIndices: number[] = [];
  const admitted = new Set<number>();

  const decisionEntries = candidates
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.kind === "decision");
  const totalDecisions = decisionEntries.length;
  const reserveFloorCount = Math.min(RESERVE_MIN_COUNT, totalDecisions);
  const totalDecisionBytes = decisionEntries.reduce(
    (sum, x) => sum + recordBytes(x.c),
    0,
  );
  const reserveFloorBytes = Math.min(RESERVE_MIN_BYTES, totalDecisionBytes);

  let reservedBytes = 0;
  let reservedCount = 0;

  for (const { c, i } of decisionEntries) {
    if (reservedCount >= reserveFloorCount && reservedBytes >= reserveFloorBytes) {
      break;
    }
    const result = tryAdmit(selected, c);
    if (result === null) break;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
    reservedBytes += recordBytes(result);
    reservedCount++;
  }

  for (let i = 0; i < candidates.length; i++) {
    if (admitted.has(i)) continue;
    const result = tryAdmit(selected, candidates[i] as SectionRecord);
    if (result === null) continue;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
  }

  const omittedOriginalIndices = candidates
    .map((_, i) => i)
    .filter((i) => !admitted.has(i));

  if (omittedOriginalIndices.length === 0) {
    return { records: selected, index: null };
  }

  return fitIndex(selected, selectedOriginalIndices, omittedOriginalIndices, candidates, file);
}

function indexNonFileBytes(omittedCount: number, ids: string[]): number {
  return byteLength(JSON.stringify({ omittedCount, ids }));
}

function buildIndex(
  omittedCount: number,
  candidateIds: string[],
  file: string,
): ContinuationIndex {
  let ids = candidateIds.slice(0, INDEX_MAX_IDS);
  while (ids.length > 0 && indexNonFileBytes(omittedCount, ids) > INDEX_NON_FILE_MAX_BYTES) {
    ids = ids.slice(0, -1);
  }
  return { omittedCount, ids, file };
}

function buildIndexFromOmitted(
  omittedOriginalIndices: number[],
  candidates: SectionRecord[],
  file: string,
): ContinuationIndex {
  const ids = omittedOriginalIndices
    .map((i) => candidates[i]?.id)
    .filter((x): x is string => x !== null && x !== undefined);
  return buildIndex(omittedOriginalIndices.length, ids, file);
}

function fitIndex(
  selected: SectionRecord[],
  selectedOriginalIndices: number[],
  omittedOriginalIndices: number[],
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: ContinuationIndex } {
  const working = [...selected];
  const workingIndices = [...selectedOriginalIndices];
  const omitted = [...omittedOriginalIndices];

  let index = buildIndexFromOmitted(omitted, candidates, file);

  // `working` is ordered [reserve-pass records..., fill-pass records...], so
  // popping from the end evicts the last fill-pass record first and only
  // reaches reserve-pass decisions (most-recently-reserved first) once every
  // fill-pass record is gone -- exactly the eviction order the plan
  // specifies, with no separate bookkeeping needed.
  while (
    working.length > 0 &&
    (!fitsEnvelope(working, index) || working.length + 1 > CAP_RECORDS)
  ) {
    working.pop();
    const evictedOriginalIndex = workingIndices.pop() as number;
    omitted.push(evictedOriginalIndex);
    index = buildIndexFromOmitted(omitted, candidates, file);
  }

  return { records: working, index };
}

// ---------------------------------------------------------------------------
// Trajectory list
// ---------------------------------------------------------------------------

export function buildTrajectory(
  handovers: TrajectoryHandoverInput[],
): TrajectoryEntry[] {
  const byId = new Map<
    string,
    {
      occurrenceCount: number;
      firstSeenInWindow: string;
      latest: string;
      latestDisposition: TrajectoryDisposition;
    }
  >();

  // handovers is expected newest-to-oldest. We iterate in that order so the
  // FIRST time we see an id, it's the newest (latest) mention.
  for (const handover of handovers) {
    // Within one handover, resolve a same-id tie (e.g. shipped AND
    // continuation both name it) by whichever occurrence is textually
    // first -- round-1 code review finding: trajectory-ordering. This
    // requires the caller's occurrences to already be in document order;
    // relying on Map insertion order over that stream is what implements
    // "textually first" here.
    const firstDispositionThisHandover = new Map<string, TrajectoryDisposition>();
    for (const occurrence of handover.orderedIdOccurrences) {
      if (!firstDispositionThisHandover.has(occurrence.id)) {
        firstDispositionThisHandover.set(occurrence.id, occurrence.disposition);
      }
    }

    for (const [id, disposition] of firstDispositionThisHandover) {
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          occurrenceCount: 1,
          firstSeenInWindow: handover.filename,
          latest: handover.filename,
          latestDisposition: disposition,
        });
      } else {
        existing.occurrenceCount += 1;
        existing.firstSeenInWindow = handover.filename;
      }
    }
  }

  return Array.from(byId.entries()).map(([id, entry]) => ({ id, ...entry }));
}
