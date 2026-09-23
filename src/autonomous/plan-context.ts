/**
 * T-526 (P-1): the one contract every PLAN entry shares. Four places build a
 * PLAN instruction (the pick, the plan-mode start, `PlanStage.enter` for a
 * replan or a resume, and drift recovery); each calls `withPlanContext`, so
 * the brief, the obligations, the tier rule and the EXISTING requirement read
 * the same on every path.
 */
import { TIER_RULE } from "./context-brief.js";
import {
  CONTEXT_BRIEF_FILE,
  currentItemId,
  governingChangeGate,
  obligationLines,
  prepareContextForPlan,
  readContextManifests,
  type ContextPointer,
} from "./context-manifest.js";
import type { StageContext } from "./stages/types.js";

/** B-D, the two shapes an EXISTING line takes. */
export const EXISTING_SHAPES = [
  "EXISTING: <reference> ; reuse | extend | replace ; <one-line reason>",
  "EXISTING: none found within <modules inspected>; closest <candidate> lacks <what>; new implementation limited to <scope>",
] as const;

/** T-526: what the plan reviewer is told to treat as findings, on every ticket plan. */
export const PLAN_REVIEWER_CHECKS = [
  "The plan's EXISTING line is a conclusion about the implementation that already covers this area. A grep transcript or a bare `EXISTING: none` in its place is a finding.",
  "A suggested ruling that applies to this plan and is not cited on the item is a finding.",
] as const;

export function existingRequirementLines(): string[] {
  return [
    "The plan must contain an EXISTING line, a conclusion about the implementation that already covers this area, in one of these shapes:",
    "",
    ...EXISTING_SHAPES.map((s) => `    ${s}`),
    "",
    "A capability entry is where inspection starts, not a substitute for reading the implementation before writing the line. A bare `EXISTING: none` or a grep transcript in place of a conclusion is a defect at plan review.",
  ];
}

/**
 * Why a plan's EXISTING line does not satisfy the requirement, or null when it
 * does. The first line starting `EXISTING:` is the one judged; it must carry
 * content, and a `none` conclusion must say what was inspected (`within`).
 */
export function existingLineProblem(plan: string): string | null {
  const line = plan.split(/\r?\n/).find((l) => /^EXISTING:/.test(l));
  if (line === undefined || !/^EXISTING:\s*\S/.test(line)) return "the plan has no EXISTING line";
  if (/^EXISTING:\s*none\b/i.test(line) && !/\bwithin\b/i.test(line)) {
    return "the EXISTING line says none without naming what was inspected (`none found within <modules inspected>`)";
  }
  return null;
}

export function existingRetryInstruction(problem: string): string {
  return [`Plan not accepted: ${problem}.`, "", ...existingRequirementLines(), "", "Add the line to the plan file and call me again."].join("\n");
}

function briefBlock(sessionId: string): string {
  return [
    "## Context brief",
    "",
    `Read \`.story/sessions/${sessionId}/${CONTEXT_BRIEF_FILE}\` before planning: the item's binding rulings, suggested rulings, capabilities, terms and what discovery could not see.`,
    TIER_RULE,
    "",
    ...existingRequirementLines(),
  ].join("\n");
}

/**
 * Gate, publish and persist for the current item, then wrap `instruction`:
 * obligation and recovery lines first, the brief block last. Never throws: a
 * failure inside is carried as a line, because a PLAN instruction that cannot
 * be delivered is worse than one that says what it is missing.
 */
export async function withPlanContext(ctx: StageContext, instruction: string): Promise<string> {
  const item = currentItemId(ctx.state);
  if (item === null || ctx.state.currentIssue) return instruction;
  let preamble: readonly string[] = [];
  try {
    const prepared = await prepareContextForPlan(ctx.root, ctx.dir, ctx.state, item);
    if (prepared.contextManifests !== null) ctx.writeState({ contextManifests: prepared.contextManifests } as Partial<typeof ctx.state>);
    preamble = prepared.preamble;
  } catch (err) {
    preamble = [`context brief unavailable (${(err as Error).message}); plan from the item and its cited rulings, and say so in the plan`];
  }
  const head = preamble.length > 0 ? `${preamble.map((l) => `> ${l}`).join("\n")}\n\n` : "";
  return `${head}${instruction}\n\n${briefBlock(ctx.state.sessionId)}`;
}

/** The pointer for the current item, or null (none, or unreadable). */
export function currentPointer(ctx: StageContext): ContextPointer | null {
  const item = currentItemId(ctx.state);
  if (item === null) return null;
  const read = readContextManifests((ctx.state as { contextManifests?: unknown }).contextManifests);
  return read.ok ? read.map[item] ?? null : null;
}

/** Why the pointer map for this session cannot be read, or null when it can (or there is no item). */
export function pointerMapUnreadable(ctx: StageContext): string | null {
  if (currentItemId(ctx.state) === null || ctx.state.currentIssue) return null;
  const read = readContextManifests((ctx.state as { contextManifests?: unknown }).contextManifests);
  return read.ok ? null : read.reason;
}

/**
 * Rendered at CODE_REVIEW while the pointer map cannot be read. Unreadable is
 * never treated as "no obligations": the governing context of the approved
 * plan is unknown, so no review may run. Nothing here rewrites the map.
 */
export function renderGovernanceHold(reason: string): string {
  return [
    `Holding: this item's governing context cannot be verified (${reason}).`,
    "Do NOT review the code and do NOT submit a verdict. Escalate to your operator: the session's contextManifests state is damaged and must be repaired before code review, or skip the item with completedAction \"skip_ticket\".",
  ].join("\n");
}

/**
 * The gate outside PLAN (resume, drift, CODE_REVIEW entry): diff, persist when
 * anything changed, and return the lines to show. An unreadable pointer map is
 * reported, never rewritten.
 */
export async function runGoverningGate(ctx: StageContext): Promise<{ lines: string[]; pointer: ContextPointer | null; unreadable: string | null }> {
  const item = currentItemId(ctx.state);
  if (item === null || ctx.state.currentIssue) return { lines: [], pointer: null, unreadable: null };
  try {
    const gate = await governingChangeGate(ctx.root, ctx.dir, ctx.state, item);
    if (gate.unreadable !== null) return { lines: [`recovery required: ${gate.unreadable}`], pointer: null, unreadable: gate.unreadable };
    if (gate.changed) ctx.writeState({ contextManifests: gate.map } as Partial<typeof ctx.state>);
    return { lines: obligationLines(gate.pointer), pointer: gate.pointer, unreadable: null };
  } catch (err) {
    // Not verified is not clear: the failure is carried as unreadable, so
    // CODE_REVIEW holds on it exactly as on a damaged map.
    const reason = `governing context could not be checked (${(err as Error).message})`;
    return { lines: [reason], pointer: currentPointer(ctx), unreadable: reason };
  }
}
