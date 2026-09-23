/**
 * T-527: KNOWLEDGE_REVIEW, between FINALIZE and COMPLETE.
 *
 * FINALIZE has committed the item and recorded the review it owes
 * (`state.knowledgeReview`, pending). This stage asks the agent what the item
 * did to the project's knowledge (capabilities, glossary, notes, rulings) and
 * accepts the answer only once `knowledge-verify.ts` has backed it with the
 * ledger's own history. The item is not complete until then.
 *
 * The stage works from `state.knowledgeReview` alone. FINALIZE cleared
 * `ticket` / `currentIssue` in the write that recorded the review, so the
 * item is loaded from the ledger at the implementation commit by id, never
 * from session fields.
 *
 * Evidence is DISPLAY ONLY. It is cached per (attempt, implementation commit)
 * so a resume shows the same picture, and validation never reads it: every
 * rule reads git.
 *
 * Nothing here commits. The only side effects are the state writes (a
 * rebase moves the checkpoint; an acceptance stores the report, keyed by
 * attempt and commit, in the same write as the transition to COMPLETE), which
 * is why a replayed report after a resume cannot duplicate anything.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import {
  KnowledgeEvidenceCacheSchema,
  KnowledgeImpactSchema,
  type FullSessionState,
  type GuideReportInput,
  type KnowledgeEvidenceCache,
} from "../session-types.js";
import {
  confirmHead,
  realKnowledgeGit,
  verifyKnowledgeRebase,
  verifyKnowledgeReport,
  type KnowledgeGit,
  type KnowledgeRefusal,
} from "../knowledge-verify.js";
import { gitChangedPaths } from "../git-inspector.js";
import { atomicWriteSync } from "../status-writer.js";
import { CAPABILITIES_CAP, STALE_CAP, STALE_CODES, TERMS_CAP } from "../context-brief.js";
import { readLedgerSnapshot, type LedgerSnapshot } from "../../core/ledger-snapshot.js";
import { checkCapabilities, matchCapabilities, queryPathRefusal } from "../../core/capability.js";
import { catalogConflictScope } from "../../core/catalog-conflicts.js";
import { buildTermReferenceIndexFromSnapshot, checkTerms, matchTerms } from "../../core/glossary.js";
import { buildCitationResolutionContext } from "../../core/ruling.js";
import { escapeMarkdownInline } from "../../core/output-formatter.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import { catalogPath } from "../../cli/commands/capability.js";
import { hasPendingNote } from "../../models/capability.js";
import type { KnowledgeReviewRecord } from "./knowledge-routing.js";

export type KnowledgeImpactRecord = FullSessionState["knowledgeImpacts"][number];

/** Changed paths shown in the instruction; the rest are counted. */
export const CHANGED_PATHS_SHOWN = 40;

/**
 * Bounds on the evidence as RENDERED. The builder caps record counts, but a
 * field can be as large as the catalog allows and the cache is read back from
 * disk, so the renderer bounds every field, every list and the section as a
 * whole: rebuilt and cached evidence are held to the same limits.
 */
export const EVIDENCE_FIELD_CHARS = 200;
export const EVIDENCE_LIST_SHOWN = 5;
export const RULINGS_SHOWN = 10;
export const DISCLOSURES_SHOWN = 10;
export const EVIDENCE_BUDGET_BYTES = 12_000;

export const CHANGED_PATHS_DISCLOSURE =
  "committed changes since session start on the shared branch; may include other sessions' commits";

// --- storage ---

/**
 * Store an accepted report under `(itemAttemptId, implementationCommit)`.
 * The same key accepted twice replaces the earlier record in place; any other
 * key is appended. Exported so the key itself can be tested directly.
 */
export function upsertKnowledgeImpact(
  existing: readonly KnowledgeImpactRecord[],
  record: KnowledgeImpactRecord,
): KnowledgeImpactRecord[] {
  const index = existing.findIndex(
    (r) => r.itemAttemptId === record.itemAttemptId && r.implementationCommit === record.implementationCommit,
  );
  if (index === -1) return [...existing, record];
  const out = [...existing];
  out[index] = record;
  return out;
}

// --- evidence ---

/** The cache file for one review. The id segment is reduced to a safe filename; the identity lives inside. */
export function evidenceCachePath(sessionDir: string, review: Pick<KnowledgeReviewRecord, "itemAttemptId" | "implementationCommit">): string {
  const attempt = review.itemAttemptId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(sessionDir, `knowledge-evidence-${attempt}-${review.implementationCommit.slice(0, 8)}.json`);
}

function readCachedEvidence(path: string, review: KnowledgeReviewRecord): KnowledgeEvidenceCache | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = KnowledgeEvidenceCacheSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) return null;
    // A valid-shaped file for another attempt or commit is not this review's evidence.
    if (parsed.data.itemAttemptId !== review.itemAttemptId || parsed.data.implementationCommit !== review.implementationCommit) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

interface ReviewedItem {
  readonly text: string;
  readonly citesRulings: readonly string[];
}

function itemAt(snapshot: LedgerSnapshot, review: KnowledgeReviewRecord): ReviewedItem | string {
  if (review.kind === "ticket") {
    const read = snapshot.tickets();
    if (!read.available) return "the ledger at the implementation commit could not be read";
    const t = read.records.find((r) => r.id === review.itemId);
    if (!t) return `${review.itemId} is not a readable ticket at the implementation commit`;
    return { text: `${t.title}\n${t.description ?? ""}`, citesRulings: t.citesRulings ?? [] };
  }
  const read = snapshot.issues();
  if (!read.available) return "the ledger at the implementation commit could not be read";
  const i = read.records.find((r) => r.id === review.itemId);
  if (!i) return `${review.itemId} is not a readable issue at the implementation commit`;
  return { text: [i.title, i.impact, ...(i.location ?? [])].join("\n"), citesRulings: i.citesRulings ?? [] };
}

/** Build the evidence from git and the ledger at the implementation commit. Never throws for a ledger problem; it discloses it. */
export async function buildKnowledgeEvidence(
  root: string,
  state: FullSessionState,
  review: KnowledgeReviewRecord,
): Promise<KnowledgeEvidenceCache> {
  const disclosure: string[] = [];
  const initHead = state.git.initHead;
  let changedPaths: KnowledgeEvidenceCache["changedPaths"];
  if (!initHead) {
    changedPaths = { unavailable: "no session start commit is recorded" };
  } else {
    const read = await gitChangedPaths(root, initHead, review.implementationCommit);
    changedPaths = read.ok
      ? { paths: read.data.map((c) => ({ status: c.status, path: c.path, ...(c.oldPath !== undefined && { oldPath: c.oldPath }) })), disclosure: CHANGED_PATHS_DISCLOSURE }
      : { unavailable: sanitizeDisplayText(read.message, 200) };
  }

  // Both rename endpoints are keys: the old path is what a stale entry still names.
  const keys: string[] = [];
  if ("paths" in changedPaths) {
    for (const c of changedPaths.paths) {
      for (const p of c.oldPath !== undefined ? [c.oldPath, c.path] : [c.path]) {
        if (!keys.includes(p) && queryPathRefusal(p) === null) keys.push(p);
      }
    }
  }

  const baseline = await readLedgerSnapshot(root, review.implementationCommit);
  if (baseline.availability.kind !== "ok") disclosure.push(`ledger at the implementation commit unavailable: ${baseline.availability.reason}`);
  const item = itemAt(baseline, review);
  if (typeof item === "string") disclosure.push(item);

  let capabilities: KnowledgeEvidenceCache["capabilities"] = [];
  let stale: KnowledgeEvidenceCache["stale"] = [];
  let capabilitiesTotal = 0;
  let staleTotal = 0;
  const caps = baseline.capabilities();
  if (caps.kind === "ok" && caps.entries.length > 0 && keys.length > 0) {
    // T-529: an entry the file's own conflict records name is never shown as settled.
    const scope = catalogConflictScope(caps, caps.entries.map((e) => e.id));
    const report = await checkCapabilities(root, caps.entries, null, {
      snapshot: baseline,
      headOid: review.implementationCommit,
      conflictedIds: scope.conflictedIds,
      problemIds: scope.problemIds,
    });
    if (report.deadlineHit || report.unchecked.length > 0) {
      disclosure.push(`capability freshness incomplete for ${new Set(report.unchecked).size} entr(ies)`);
    }
    const checkOf = (id: string) => report.entries.find((e) => e.id === id);
    const staleIds = new Map<string, string>();
    for (const e of report.entries) {
      const hit = e.results.find((r) => STALE_CODES.has(r.code));
      if (hit) staleIds.set(e.id, hit.detail);
    }
    const matched = matchCapabilities(caps.entries, { paths: keys }, null, new Map([...staleIds, ...scope.excluded])).matches;
    capabilitiesTotal = matched.length;
    capabilities = matched.slice(0, CAPABILITIES_CAP).map((m) => ({
      id: m.capability.id,
      name: m.capability.name,
      effectiveStatus: checkOf(m.capability.id)?.effectiveStatus ?? (hasPendingNote(m.capability) ? "review" : m.capability.status),
      reasons: m.reasons.map((r) => r.detail),
    }));
    const staleEntries = caps.entries.filter((e) => staleIds.has(e.id));
    const staleMatched = staleEntries.length > 0 ? matchCapabilities(staleEntries, { paths: keys }).matches : [];
    staleTotal = staleMatched.length;
    stale = staleMatched.slice(0, STALE_CAP).map((m) => ({
      id: m.capability.id,
      reason: staleIds.get(m.capability.id)!,
      failures: (checkOf(m.capability.id)?.results ?? [])
        .filter((r) => r.cls !== "freshness" || r.code === "capability_changed")
        .map((r) => r.detail),
      pendingNote: hasPendingNote(m.capability) ? m.capability.pendingNote! : null,
    }));
  } else if (caps.kind === "unreadable" || caps.kind === "oid-unavailable") {
    disclosure.push(`capability inventory unreadable at the implementation commit: ${caps.reason}`);
  }

  let terms: KnowledgeEvidenceCache["terms"] = [];
  let termsTotal = 0;
  const glossary = baseline.terms();
  if (glossary.kind === "ok" && typeof item !== "string") {
    const checked = checkTerms(glossary.entries, buildTermReferenceIndexFromSnapshot(baseline));
    const matched = matchTerms(item.text, glossary.entries);
    termsTotal = matched.length;
    terms = matched.slice(0, TERMS_CAP).map((m) => ({
      id: m.id,
      term: m.term,
      effectiveStatus: checked.entries.find((e) => e.id === m.id)?.effectiveStatus ?? "review",
    }));
  } else if (glossary.kind === "unreadable" || glossary.kind === "oid-unavailable") {
    disclosure.push(`glossary unreadable at the implementation commit: ${glossary.reason}`);
  }

  let rulings: KnowledgeEvidenceCache["rulings"] = [];
  if (typeof item !== "string" && item.citesRulings.length > 0) {
    const scan = baseline.rulingsScan();
    const ctx = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries);
    rulings = item.citesRulings.map((id) => ({ id, lifecycle: ctx.lifecycleById.get(id) ?? "unresolved" }));
  }

  return {
    version: 1,
    itemAttemptId: review.itemAttemptId,
    implementationCommit: review.implementationCommit,
    changedPaths,
    capabilities,
    stale,
    terms,
    rulings,
    truncated: {
      capabilities: capabilitiesTotal > capabilities.length,
      stale: staleTotal > stale.length,
      terms: termsTotal > terms.length,
    },
    disclosure,
  };
}

/** The cached evidence, regenerated when absent, invalid or carrying another identity. */
export async function loadKnowledgeEvidence(ctx: StageContext, review: KnowledgeReviewRecord): Promise<KnowledgeEvidenceCache> {
  const path = evidenceCachePath(ctx.dir, review);
  const cached = readCachedEvidence(path, review);
  if (cached) return cached;
  const evidence = await buildKnowledgeEvidence(ctx.root, ctx.state, review);
  // Best-effort: a failed write only means the next entry rebuilds it.
  atomicWriteSync(path, JSON.stringify(evidence, null, 2));
  return evidence;
}

// --- instruction ---

function short(oid: string): string {
  return oid.slice(0, 12);
}

/** One evidence field on one line: control characters marked, length capped, then escaped. */
function evidenceText(value: string): string {
  return escapeMarkdownInline(sanitizeDisplayText(value, EVIDENCE_FIELD_CHARS));
}

function itemLabel(state: FullSessionState, review: KnowledgeReviewRecord): string {
  if (review.kind === "ticket") {
    const done = [...state.completedTickets].reverse().find((t) => t.id === review.itemId);
    const display = done?.displayId ?? review.itemId;
    return done?.title ? `${evidenceText(display)}: ${evidenceText(done.title)}` : evidenceText(display);
  }
  return evidenceText(state.resolvedIssueDisplayIds?.[review.itemId] ?? review.itemId);
}

/** Cut the section at the byte budget, on a line boundary, saying so. */
function withinEvidenceBudget(lines: string[]): string[] {
  const cut = `- evidence cut at the ${EVIDENCE_BUDGET_BYTES}-byte display budget; the rest is in \`storybloq capability check\`, \`capability match\` and \`term match\``;
  if (Buffer.byteLength(lines.join("\n"), "utf8") <= EVIDENCE_BUDGET_BYTES) return lines;
  const out: string[] = [];
  let bytes = Buffer.byteLength(cut, "utf8") + 1;
  for (const line of lines) {
    const next = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + next > EVIDENCE_BUDGET_BYTES) break;
    out.push(line);
    bytes += next;
  }
  out.push(cut);
  return out;
}

function evidenceLines(evidence: KnowledgeEvidenceCache): string[] {
  const lines: string[] = ["## Evidence", "", "Display only: validation reads git, never this list. Records outside the displayed caps may be reported.", ""];
  if ("unavailable" in evidence.changedPaths) {
    lines.push(`Changed paths: unavailable (${evidenceText(evidence.changedPaths.unavailable)}).`);
  } else {
    const paths = evidence.changedPaths.paths;
    lines.push(`Changed paths (${evidenceText(evidence.changedPaths.disclosure)}): ${paths.length}`);
    for (const c of paths.slice(0, CHANGED_PATHS_SHOWN)) {
      const status = evidenceText(c.status);
      lines.push(c.oldPath !== undefined ? `- ${status} ${catalogPath(c.oldPath)} -> ${catalogPath(c.path)}` : `- ${status} ${catalogPath(c.path)}`);
    }
    if (paths.length > CHANGED_PATHS_SHOWN) lines.push(`- and ${paths.length - CHANGED_PATHS_SHOWN} more`);
  }
  lines.push("");
  // Stale first: an entry whose entry point was renamed or deleted is the strongest signal.
  lines.push("### Stale capability entries (renamed or deleted entry points first)");
  if (evidence.stale.length === 0) lines.push("none matched by the changed paths");
  for (const s of evidence.stale.slice(0, STALE_CAP)) {
    lines.push(`- ${evidenceText(s.id)}: ${evidenceText(s.reason)}`);
    for (const f of s.failures.slice(0, EVIDENCE_LIST_SHOWN)) lines.push(`  check: ${evidenceText(f)}`);
    if (s.failures.length > EVIDENCE_LIST_SHOWN) lines.push(`  check: ${s.failures.length - EVIDENCE_LIST_SHOWN} more not shown`);
    if (s.pendingNote !== null) lines.push(`  pending: ${evidenceText(s.pendingNote)}`);
  }
  if (evidence.truncated.stale || evidence.stale.length > STALE_CAP) lines.push(`- more not shown (cap ${STALE_CAP}); list them with \`storybloq capability check\``);
  lines.push("", "### Capabilities matched by the changed paths");
  if (evidence.capabilities.length === 0) lines.push("none");
  for (const c of evidence.capabilities.slice(0, CAPABILITIES_CAP)) {
    const reasons = c.reasons.slice(0, EVIDENCE_LIST_SHOWN).map(evidenceText);
    if (c.reasons.length > EVIDENCE_LIST_SHOWN) reasons.push(`${c.reasons.length - EVIDENCE_LIST_SHOWN} more`);
    lines.push(`- **${evidenceText(c.name)}** (${evidenceText(c.id)}) [${evidenceText(c.effectiveStatus)}]: ${reasons.join("; ")}`);
  }
  if (evidence.truncated.capabilities || evidence.capabilities.length > CAPABILITIES_CAP) lines.push(`- more not shown (cap ${CAPABILITIES_CAP}); list them with \`storybloq capability match\``);
  lines.push("", "### Terms named by the item");
  if (evidence.terms.length === 0) lines.push("none");
  for (const t of evidence.terms.slice(0, TERMS_CAP)) lines.push(`- **${evidenceText(t.term)}** (${evidenceText(t.id)}) [${evidenceText(t.effectiveStatus)}]`);
  if (evidence.truncated.terms || evidence.terms.length > TERMS_CAP) lines.push(`- more not shown (cap ${TERMS_CAP}); list them with \`storybloq term match\``);
  lines.push("", "### Rulings the item cites");
  if (evidence.rulings.length === 0) lines.push("none");
  for (const r of evidence.rulings.slice(0, RULINGS_SHOWN)) lines.push(`- ${evidenceText(r.id)} (${evidenceText(r.lifecycle)})`);
  if (evidence.rulings.length > RULINGS_SHOWN) lines.push(`- and ${evidence.rulings.length - RULINGS_SHOWN} more`);
  if (evidence.disclosure.length > 0) {
    lines.push("", "Not covered:");
    for (const d of evidence.disclosure.slice(0, DISCLOSURES_SHOWN)) lines.push(`- ${evidenceText(d)}`);
    if (evidence.disclosure.length > DISCLOSURES_SHOWN) lines.push(`- and ${evidence.disclosure.length - DISCLOSURES_SHOWN} more`);
  }
  return withinEvidenceBudget(lines);
}

export function knowledgeReviewInstruction(
  state: FullSessionState,
  review: KnowledgeReviewRecord,
  evidence: KnowledgeEvidenceCache,
): string {
  const example = {
    sessionId: state.sessionId,
    action: "report",
    report: {
      completedAction: "knowledge_reviewed",
      knowledgeImpact: {
        implementationCommit: review.implementationCommit,
        maintenanceCommits: [],
        checked: ["cap-<id>", "term-<id>"],
        outcome: "none",
        reason: "<why nothing the item changed affects these records>",
      },
    },
  };
  const rebased = review.checkpoint !== review.implementationCommit
    ? [`Checkpoint moved to ${short(review.checkpoint)} by knowledge_rebase; the ledger baseline is still ${short(review.implementationCommit)}.`, ""]
    : [];
  return [
    `# Knowledge review: ${itemLabel(state, review)}`,
    "",
    `The ${review.kind} was committed at ${short(review.implementationCommit)}. Before it is complete, report what it did to the project's knowledge: capabilities, glossary terms, notes and rulings.`,
    "",
    ...rebased,
    ...evidenceLines(evidence),
    "",
    "## Report",
    "",
    "`outcome` is `none` (with `reason`), `uncertain` (with `reason`, becomes an open question in the handover) or `impacts` (with `impacts`). `checked` names what you inspected and is never empty.",
    "Each impact is `{ record, kind, proposed, disposition, evidence: { record, issueId?, proposalId? } }`, and `evidence.record` equals `record`. The accepted rows:",
    "- `cap-` stale-reference or capability-changed: `applied` (entry updated and its check current) or `pending` (marker below)",
    "- `cap-` capability-added: `applied` (new entry, check current) or `pending` (entry present with a marker)",
    "- `cap-` capability-removed: `pending` only, with a marker note starting `retire:`",
    "- `term-` term-drift: `applied` (definition updated) or `pending` (marker)",
    "- `N-`/`n-` stale-reference: `applied` (note updated) or `pending` with `issueId` (an open issue whose title or impact names the note id)",
    `- \`r-\` ruling-conflict: \`needs-decision\` only, with \`proposalId\`: a proposal (\`storybloq_ruling_propose\`) whose proposesToSupersede is the ruling and whose proposedFor includes ${evidenceText(review.itemId)}`,
    "A marker is `storybloq capability defer <id> --note \"<text naming the id>\" [--issue ISS-n]` (or `term defer`).",
    "",
    "```json",
    JSON.stringify(example),
    "```",
    "",
    "If code was committed after the checkpoint, report `{ \"completedAction\": \"knowledge_rebase\" }` first; the ledger baseline never moves.",
  ].join("\n");
}

const REMINDERS: readonly string[] = [
  "A ruling conflict is flagged with a proposal, never fixed by rewriting the accepted ruling.",
  "Offer a stamp (`storybloq capability check --stamp <id>`) for entries you inspected and found still accurate.",
  "Every ledger change made here is committed in `.story/`-only commits, listed oldest first in `maintenanceCommits`, and nothing under `.story/` is left uncommitted.",
  "Maintenance that landed inside a commit that also changed code is recovered per record: `capability restore` / `term restore` / `ledger restore` to the baseline content (`--expect` the mixed commit) in one ledger-only commit, the change re-applied in another, both listed.",
];

// --- stage ---

export class KnowledgeReviewStage implements WorkflowStage {
  readonly id = "KNOWLEDGE_REVIEW";

  /** Test seam: the git the rules read. */
  constructor(private readonly gitFor: (root: string) => KnowledgeGit = realKnowledgeGit) {}

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const review = ctx.state.knowledgeReview;
    // Nothing owed (accepted, or a state with no review): the item completes.
    if (!review || review.status !== "pending") return { action: "goto", target: "COMPLETE" };
    const evidence = await loadKnowledgeEvidence(ctx, review);
    return {
      instruction: knowledgeReviewInstruction(ctx.state, review, evidence),
      reminders: REMINDERS,
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const review = ctx.state.knowledgeReview;
    // A replay after acceptance, or no review at all: complete with no write.
    if (!review || review.status !== "pending") return { action: "goto", target: "COMPLETE" };
    const git = this.gitFor(ctx.root);
    const ref = { itemId: review.itemId, implementationCommit: review.implementationCommit, checkpoint: review.checkpoint };

    if (report.completedAction === "knowledge_rebase") {
      const rebase = await verifyKnowledgeRebase(git, ref);
      if (!rebase.ok) return refusal(rebase);
      const moved: KnowledgeReviewRecord = {
        ...review,
        checkpoint: rebase.head,
        checkpoints: [...(review.checkpoints ?? []), review.checkpoint],
      };
      ctx.writeState({ knowledgeReview: moved });
      ctx.appendEvent("knowledge_rebase", { itemId: review.itemId, from: review.checkpoint, to: rebase.head });
      const evidence = await loadKnowledgeEvidence(ctx, moved);
      return {
        action: "retry",
        instruction: knowledgeReviewInstruction(ctx.state, moved, evidence),
        reminders: REMINDERS,
      };
    }

    if (report.completedAction !== "knowledge_reviewed") {
      return {
        action: "retry",
        instruction: `KNOWLEDGE_REVIEW accepts completedAction "knowledge_reviewed" (with knowledgeImpact) or "knowledge_rebase"; got "${sanitizeDisplayText(report.completedAction, 80)}".`,
      };
    }

    const parsed = KnowledgeImpactSchema.safeParse(report.knowledgeImpact);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "knowledgeImpact"}: ${i.message}`);
      return {
        action: "retry",
        instruction: `knowledgeImpact is missing or invalid: ${issues.join("; ")}. Report again with a knowledgeImpact object as shown in the instruction.`,
      };
    }
    const verified = await verifyKnowledgeReport(ctx.root, ref, parsed.data, { git });
    if (!verified.ok) return refusal(verified);
    // Rule (f): HEAD is re-read immediately before the acceptance is persisted.
    const headMoved = await confirmHead(git, verified.head);
    if (headMoved !== null) return refusal(headMoved);

    const record: KnowledgeImpactRecord = {
      itemId: review.itemId,
      kind: review.kind,
      itemAttemptId: review.itemAttemptId,
      implementationCommit: review.implementationCommit,
      headAtAcceptance: verified.head,
      maintenanceCommits: [...verified.maintenanceCommits],
      externalMaintenance: verified.externalMaintenance.map((e) => ({ id: e.id, commit: e.commit })),
      checkpoints: review.checkpoints && review.checkpoints.length > 0 ? [...review.checkpoints, review.checkpoint] : [],
      acceptedAt: new Date().toISOString(),
      report: parsed.data,
    };
    // Drafted, not written: persisted by the transition's own write, so the
    // acceptance and the move to COMPLETE are one state change.
    ctx.updateDraft({
      knowledgeReview: { ...review, status: "accepted" },
      knowledgeImpacts: upsertKnowledgeImpact(ctx.state.knowledgeImpacts ?? [], record),
    });
    ctx.appendEvent("knowledge_reviewed", {
      itemId: review.itemId,
      itemAttemptId: review.itemAttemptId,
      implementationCommit: review.implementationCommit,
      outcome: parsed.data.outcome,
      impacts: parsed.data.impacts?.length ?? 0,
      maintenanceCommits: record.maintenanceCommits.length,
      externalMaintenance: record.externalMaintenance.length,
    });
    return { action: "goto", target: "COMPLETE" };
  }
}

function refusal(r: KnowledgeRefusal): StageAdvance {
  return {
    action: "retry",
    instruction: r.condition === "knowledge_diverged"
      ? `knowledge_diverged: ${r.message}`
      : `Knowledge review not accepted: ${r.message}`,
    reminders: REMINDERS,
  };
}
