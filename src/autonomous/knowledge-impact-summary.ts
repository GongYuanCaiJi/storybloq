/**
 * T-527 (plan 3.8): how accepted knowledge reviews are shown downstream.
 *
 * One renderer serves the three places that show them: the "Knowledge impact"
 * section appended to the session handover, the `session_report` section, and
 * COMPLETE's one-line summary. The handover section is deterministic and comes
 * from state, never from what the agent wrote, so an owner reading the
 * handover sees what was actually accepted.
 *
 * Everything rendered here comes out of a state.json this build may not have
 * written (ISS-897): every value is sanitized and escaped as a document before
 * it lands in Markdown, every list is bounded with a pointer to the full set in
 * state.json, and the section as a whole has a byte budget: a report may carry
 * any number of `checked` entries, and an accepted one is stored as it came.
 */
import type { FullSessionState } from "./session-types.js";
import { readContextManifests } from "./context-manifest.js";
import { boundedLines } from "../core/bounded-list.js";
import { MAX_DISPLAY_LENGTH, sanitizeDisplayText } from "../core/display-text.js";
import { escapeMarkdownDocumentStrict } from "../core/output-formatter.js";

type KnowledgeImpactRecord = FullSessionState["knowledgeImpacts"][number];

/** Items shown in one section; the most recent are kept. */
export const KNOWLEDGE_ITEMS_SHOWN = 20;
/** Impact lines shown per item. */
export const KNOWLEDGE_IMPACTS_SHOWN = 20;
/** Entries shown in one inline list (checked, rebases, commits, recovery reasons); the rest are counted. */
export const KNOWLEDGE_INLINE_SHOWN = 10;
/** The whole section, cut on a line boundary past this. */
export const KNOWLEDGE_SECTION_BUDGET_BYTES = 20_000;

const FULL_SET_HINT = "The complete list is in `knowledgeImpacts` of state.json.";

function text(value: string, maxLength = MAX_DISPLAY_LENGTH): string {
  return escapeMarkdownDocumentStrict(sanitizeDisplayText(value, maxLength));
}

function oid(value: string): string {
  return text(value.slice(0, 12));
}

/** An inline list: the first entries, then a count of the rest and where they are. */
function inline(values: readonly string[], separator: string): string {
  const shown = values.slice(0, KNOWLEDGE_INLINE_SHOWN).join(separator);
  const more = values.length - KNOWLEDGE_INLINE_SHOWN;
  return more > 0 ? `${shown} (and ${more} more; ${values.length} total). ${FULL_SET_HINT}` : shown;
}

/** The display id of a reviewed item, from the session's own completion records. */
export function knowledgeItemDisplay(
  state: Pick<FullSessionState, "completedTickets" | "resolvedIssueDisplayIds">,
  record: Pick<KnowledgeImpactRecord, "itemId" | "kind">,
): string {
  if (record.kind === "ticket") {
    const done = [...state.completedTickets].reverse().find((t) => t.id === record.itemId);
    return done?.displayId ?? record.itemId;
  }
  return state.resolvedIssueDisplayIds?.[record.itemId] ?? record.itemId;
}

/**
 * "none", "uncertain", or the impact count split by disposition. Built only
 * from the schema's enums and counts, so it is Markdown-safe as it stands and
 * is not escaped (escaping would print a literal backslash before each
 * punctuation mark).
 */
function outcomeSummary(record: KnowledgeImpactRecord): string {
  const report = record.report;
  if (report.outcome !== "impacts") return report.outcome;
  const impacts = report.impacts ?? [];
  const count = (d: string) => impacts.filter((i) => i.disposition === d).length;
  const parts = [
    count("applied") > 0 ? `${count("applied")} applied` : null,
    count("pending") > 0 ? `${count("pending")} pending` : null,
    count("needs-decision") > 0 ? `${count("needs-decision")} awaiting the owner` : null,
  ].filter((p): p is string => p !== null);
  return `${impacts.length} ${impacts.length === 1 ? "impact" : "impacts"}: ${parts.join(", ")}`;
}

/**
 * COMPLETE's one line for the review accepted just before it: the pending
 * record FINALIZE wrote, now accepted, and its stored report. Null when the
 * item owed no review or the stored report is missing.
 */
export function acceptedKnowledgeLine(state: FullSessionState): string | null {
  const review = state.knowledgeReview;
  if (!review || review.status !== "accepted") return null;
  const record = (state.knowledgeImpacts ?? []).find(
    (r) => r.itemAttemptId === review.itemAttemptId && r.implementationCommit === review.implementationCommit,
  );
  if (!record) return null;
  const tail = record.report.outcome === "uncertain" ? " It is an open question in the handover." : "";
  return `Knowledge review accepted for **${text(knowledgeItemDisplay(state, record))}**: ${outcomeSummary(record)}.${tail}`;
}

function impactLines(record: KnowledgeImpactRecord): { impacts: string[]; awaiting: string[] } {
  const impacts: string[] = [];
  const awaiting: string[] = [];
  for (const i of record.report.impacts ?? []) {
    const head = `${text(i.record)} (${text(i.kind)})`;
    if (i.disposition === "needs-decision") {
      awaiting.push(`  - ${head}: proposal ${text(i.evidence.proposalId ?? "?")}. ${text(i.proposed)}`);
    } else {
      const issue = i.evidence.issueId !== undefined ? `, follow-up ${text(i.evidence.issueId)}` : "";
      impacts.push(`  - ${head}: ${i.disposition}${issue}. ${text(i.proposed)}`);
    }
  }
  const bound = (lines: string[], noun: string) =>
    boundedLines(lines, { maxLines: KNOWLEDGE_IMPACTS_SHOWN, noun, fullSetHint: FULL_SET_HINT }).map((l) =>
      l.startsWith("- ... and") ? `  ${l}` : l,
    );
  return { impacts: bound(impacts, "impacts"), awaiting: bound(awaiting, "impacts awaiting the owner") };
}

function briefLines(state: FullSessionState, itemId: string): string[] {
  const read = readContextManifests((state as { contextManifests?: unknown }).contextManifests);
  if (!read.ok) return [`- Context brief: state unreadable (${text(read.reason)})`];
  const pointer = read.map[itemId];
  if (!pointer) return [];
  const lines: string[] = [];
  if (pointer.recovery !== null) {
    lines.push(`- Context brief recovery: ${inline(pointer.recovery.reasons.map((r) => text(r)), "; ")}`);
  }
  if (pointer.rebased !== undefined) {
    lines.push(`- Context brief rebased by ${text(pointer.rebased.by)}: ${text(pointer.rebased.reason)}`);
  }
  return lines;
}

function itemBlock(state: FullSessionState, record: KnowledgeImpactRecord): string[] {
  const report = record.report;
  const lines = [
    `### ${text(knowledgeItemDisplay(state, record))} (${record.kind}, committed at ${oid(record.implementationCommit)})`,
    "",
    `- Outcome: **${outcomeSummary(record)}**`,
  ];
  if (report.reason !== undefined) {
    lines.push(report.outcome === "uncertain" ? `- Open question: ${text(report.reason)}` : `- Reason: ${text(report.reason)}`);
  }
  lines.push(`- Checked: ${inline(report.checked.map((c) => text(c)), ", ")}`);
  const { impacts, awaiting } = impactLines(record);
  if (impacts.length > 0) lines.push("- Impacts:", ...impacts);
  if (awaiting.length > 0) lines.push("- Awaiting the owner:", ...awaiting);
  if (record.checkpoints.length > 0) {
    lines.push(`- Rebased (knowledge_rebase): ${inline(record.checkpoints.map(oid), " -> ")}`);
  }
  if (record.maintenanceCommits.length > 0) {
    lines.push(`- Maintenance commits: ${inline(record.maintenanceCommits.map(oid), ", ")}`);
  }
  if (record.externalMaintenance.length > 0) {
    lines.push(`- External maintenance (not this session's): ${inline(record.externalMaintenance.map((e) => `${text(e.id)} in ${oid(e.commit)}`), ", ")}`);
  }
  lines.push(...briefLines(state, record.itemId));
  return lines;
}

/**
 * The per-item knowledge impact of this session, as Markdown lines under
 * `heading`. Empty when no review was accepted.
 */
export function knowledgeImpactSection(state: FullSessionState, heading: string): string[] {
  const records = state.knowledgeImpacts ?? [];
  if (records.length === 0) return [];
  const shown = records.slice(-KNOWLEDGE_ITEMS_SHOWN);
  const lines = [heading, ""];
  if (shown.length < records.length) {
    lines.push(`${records.length - shown.length} earlier review(s) not shown (${records.length} total). ${FULL_SET_HINT}`, "");
  }
  shown.forEach((record, index) => {
    if (index > 0) lines.push("");
    lines.push(...itemBlock(state, record));
  });
  return withinSectionBudget(lines);
}

/** Cut the section at the byte budget, on a line boundary, saying so. */
function withinSectionBudget(lines: string[]): string[] {
  const cut = `Section cut at the ${KNOWLEDGE_SECTION_BUDGET_BYTES}-byte budget. ${FULL_SET_HINT}`;
  if (Buffer.byteLength(lines.join("\n"), "utf8") <= KNOWLEDGE_SECTION_BUDGET_BYTES) return lines;
  const out: string[] = [];
  let bytes = Buffer.byteLength(cut, "utf8") + 1;
  for (const line of lines) {
    const next = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + next > KNOWLEDGE_SECTION_BUDGET_BYTES) break;
    out.push(line);
    bytes += next;
  }
  out.push(cut);
  return out;
}
