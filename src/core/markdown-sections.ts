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

export interface ParsedHandover {
  records: SectionRecord[];
  shippedIds: string[];
  unclassifiedFallback: boolean;
}

export type TrajectoryDisposition =
  | "continuation"
  | "blocked"
  | "owner-gated"
  | "carried"
  | "shipped";

export interface TrajectoryEntry {
  id: string;
  occurrenceCount: number;
  firstSeenInWindow: string;
  latest: string;
  latestDisposition: TrajectoryDisposition;
}

export interface TrajectoryHandoverInput {
  filename: string;
  records: SectionRecord[];
  shippedIds: string[];
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

/**
 * `--` is a delimiter when surrounded by spaces or at a word's end -- not
 * absorbed into the preceding word by the hyphen-inclusive word definition.
 * We special-case it here: a word token ending in "--" (or "-") followed by
 * more hyphens is not produced by tokenizeNormalized in the first place
 * because '-' is a word character; instead we detect "--" as a delimiter by
 * scanning the RAW normalized string directly for word boundaries.
 */
function findDoubleHyphenDelimiters(normalized: string): Set<number> {
  const positions = new Set<number>();
  let idx = normalized.indexOf("--");
  while (idx !== -1) {
    positions.add(idx);
    idx = normalized.indexOf("--", idx + 2);
  }
  return positions;
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
 * token. Returns true if the heading classifies given this remainder.
 */
function classifyRemainder(remainder: string): boolean {
  const doubleHyphenPositions = findDoubleHyphenDelimiters(remainder);

  // Walk "words" in remainder, respecting that a `--` delimiter breaks a
  // word even though '-' is otherwise a word character.
  const words = splitWordsRespectingDoubleHyphen(remainder, doubleHyphenPositions);

  // First: is the position right after the token itself (start of
  // remainder) a delimiter character/end/space? Already validated by the
  // caller (boundaryOk). We now need to know: does the remainder consist of
  // ONLY a delimiter char/space run before the first word (case: heading
  // ends there, or a delimiter char immediately)? Or does it lead into a
  // word?
  const trimmedStart = leadingDelimiterCharAt0(remainder);
  if (trimmedStart) {
    // A delimiter character/`--` immediately follows the token -- classifies.
    return true;
  }

  if (words.length === 0) {
    // Only whitespace remained -- heading ends right there.
    return true;
  }

  const firstWord = words[0];
  if (firstWord === undefined) return true;
  if (DELIMITER_WORDS.has(firstWord.toLowerCase())) {
    return true;
  }

  // firstWord counts as the one permitted further word. After it, we must
  // hit end-of-string or a delimiter (char or word).
  const secondWord = words[1];
  if (secondWord === undefined) return true;
  if (DELIMITER_WORDS.has(secondWord.toLowerCase())) return true;

  // Not a delimiter word -- check whether it's actually a delimiter
  // CHARACTER immediately following the first word (e.g. "loops," where
  // the comma is captured as part of the "word" splitting boundary).
  return false;
}

function leadingDelimiterCharAt0(remainder: string): boolean {
  if (remainder.length === 0) return false;
  if (/^\s+$/.test(remainder)) return true;
  const afterSpaces = remainder.replace(/^\s+/, "");
  if (afterSpaces.length === 0) return true;
  if (/^[:,(]/.test(afterSpaces) && afterSpaces === remainder.trimStart()) {
    // A delimiter char with no word before it (only if it's truly at the
    // very front, i.e. no leading word chars were skipped to get here).
    return /^\s*[:,(]/.test(remainder) && !/^\s*[a-z0-9]/.test(remainder);
  }
  if (afterSpaces.startsWith("--")) {
    return !/^\s*[a-z0-9]/.test(remainder) || /^\s*--/.test(remainder);
  }
  return false;
}

/**
 * Splits `remainder` into word tokens (letters/digits/hyphens), treating any
 * `--` occurrence as a hard delimiter that breaks a word even though a
 * single `-` is a word character. Delimiter characters and whitespace
 * separate words but are not returned.
 */
function splitWordsRespectingDoubleHyphen(
  remainder: string,
  doubleHyphenPositions: Set<number>,
): string[] {
  const words: string[] = [];
  let current = "";
  let i = 0;
  while (i < remainder.length) {
    if (doubleHyphenPositions.has(i)) {
      if (current) {
        words.push(current);
        current = "";
      }
      i += 2;
      continue;
    }
    const ch = remainder[i] as string;
    if (isWordChar(ch)) {
      current += ch;
      i++;
    } else {
      if (current) {
        words.push(current);
        current = "";
      }
      i++;
    }
  }
  if (current) words.push(current);
  return words;
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
        if (id) shippedIds.push(id);
      }
      continue;
    }

    for (const bullet of bullets) {
      records.push(buildRecordFromBullet(bullet, category, file));
    }
  }

  if (anyClassified) {
    return { records, shippedIds, unclassifiedFallback: false };
  }

  const fallback = buildUnclassifiedFallback(sections, file);
  return {
    records: fallback ? [fallback] : [],
    shippedIds,
    unclassifiedFallback: true,
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

function shortenedRecord(record: SectionRecord): SectionRecord {
  if (record.rationale === "unknown") return record;
  return { ...record, rationale: "unknown" };
}

export function selectBoundedRecords(
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: ContinuationIndex | null } {
  const selected: SectionRecord[] = [];
  const reservedIndices = new Set<number>();
  let bytes = 0;

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
    let candidate = c;
    let candidateBytes = recordBytes(candidate);
    if (bytes + candidateBytes > CAP_BYTES) {
      candidate = shortenedRecord(candidate);
      candidateBytes = recordBytes(candidate);
    }
    if (selected.length >= CAP_RECORDS || bytes + candidateBytes > CAP_BYTES) {
      break;
    }
    selected.push(candidate);
    reservedIndices.add(i);
    bytes += candidateBytes;
    reservedBytes += candidateBytes;
    reservedCount++;
  }

  for (let i = 0; i < candidates.length; i++) {
    if (reservedIndices.has(i)) continue;
    let candidate = candidates[i] as SectionRecord;
    let candidateBytes = recordBytes(candidate);
    if (bytes + candidateBytes > CAP_BYTES) {
      candidate = shortenedRecord(candidate);
      candidateBytes = recordBytes(candidate);
    }
    if (selected.length >= CAP_RECORDS || bytes + candidateBytes > CAP_BYTES) {
      continue;
    }
    selected.push(candidate);
    bytes += candidateBytes;
  }

  const selectedSet = new Set(selected);
  const omitted = candidates.filter((c) => !selectedSet.has(c));

  if (omitted.length === 0) {
    return { records: selected, index: null };
  }

  const { records: finalSelected, index } = fitIndex(
    selected,
    omitted,
    file,
    bytes,
  );
  return { records: finalSelected, index };
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

function fitIndex(
  selected: SectionRecord[],
  omitted: SectionRecord[],
  file: string,
  selectedBytes: number,
): { records: SectionRecord[]; index: ContinuationIndex } {
  let working = [...selected];
  let currentOmitted = [...omitted];
  let bytes = selectedBytes;

  let index = buildIndex(
    currentOmitted.length,
    currentOmitted.map((o) => o.id).filter((x): x is string => x !== null),
    file,
  );

  while (working.length > 0) {
    const indexBytes = byteLength(JSON.stringify(index));
    if (bytes + indexBytes <= CAP_BYTES && working.length + 1 <= CAP_RECORDS) {
      break;
    }
    const evicted = working.pop()!;
    bytes -= recordBytes(evicted);
    currentOmitted = [...currentOmitted, evicted];
    index = buildIndex(
      currentOmitted.length,
      currentOmitted.map((o) => o.id).filter((x): x is string => x !== null),
      file,
    );
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
    const idsThisHandover = new Set<string>();
    const dispositionsThisHandover = new Map<string, TrajectoryDisposition>();

    for (const record of handover.records) {
      if (record.id === null) continue;
      if (record.disposition === "unclassified") continue;
      idsThisHandover.add(record.id);
      if (!dispositionsThisHandover.has(record.id)) {
        dispositionsThisHandover.set(record.id, record.disposition);
      }
    }
    for (const id of handover.shippedIds) {
      idsThisHandover.add(id);
      if (!dispositionsThisHandover.has(id)) {
        dispositionsThisHandover.set(id, "shipped");
      }
    }

    for (const id of idsThisHandover) {
      const disposition = dispositionsThisHandover.get(id)!;
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
