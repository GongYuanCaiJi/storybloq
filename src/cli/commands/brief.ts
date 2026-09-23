/**
 * T-526: `storybloq brief <id>` and `storybloq brief --rebase`.
 *
 * The brief is read-only: it reads the ledger, the catalogs and git, and
 * writes nothing. `--rebase` is the one write here, and it only adopts a
 * provisional context manifest a session already published.
 */
import { BriefItemNotFoundError, BRIEF_BUDGET_BYTES, buildContextBrief, type ContextBrief } from "../../autonomous/context-brief.js";
import { RebaseRefusal, rebaseContextManifest } from "../../autonomous/context-manifest.js";
import { successEnvelope } from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/** Upper bound on `--budget`: large enough for any real brief, small enough to stay a brief. */
export const BRIEF_BUDGET_MAX = 200_000;
/** Below this the mandatory sections alone overflow, which is allowed but never useful as a request. */
export const BRIEF_BUDGET_MIN = 1_000;

export function parseBriefBudget(raw: unknown): number {
  if (raw === undefined) return BRIEF_BUDGET_BYTES;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < BRIEF_BUDGET_MIN || n > BRIEF_BUDGET_MAX) {
    throw new CliValidationError("invalid_input", `--budget must be an integer from ${BRIEF_BUDGET_MIN} to ${BRIEF_BUDGET_MAX} bytes`);
  }
  return n;
}

/** The JSON form: everything the brief knows, including the exact rendered text it hashed. */
export function briefJson(brief: ContextBrief): Record<string, unknown> {
  return {
    item: brief.item,
    keys: brief.keys,
    binding: brief.binding,
    suggested: brief.suggested,
    proposed: brief.proposed,
    capabilities: brief.capabilities,
    stale: brief.stale,
    terms: brief.terms,
    lessons: brief.lessons,
    disclosure: brief.disclosure,
    families: brief.families,
    rulingsUnverifiable: brief.rulingsUnverifiable,
    delivered: brief.delivered,
    briefHash: brief.briefHash,
    rendered: brief.rendered,
  };
}

export async function handleBrief(itemRef: string, opts: { budget?: unknown }, ctx: CommandContext): Promise<CommandResult> {
  const budgetBytes = parseBriefBudget(opts.budget);
  let brief: ContextBrief;
  try {
    brief = await buildContextBrief(ctx.root, itemRef, { budgetBytes, state: ctx.state });
  } catch (err) {
    if (err instanceof BriefItemNotFoundError) throw new CliValidationError("not_found", err.message);
    throw err;
  }
  if (ctx.format === "json") return { output: JSON.stringify(successEnvelope(briefJson(brief)), null, 2) };
  return { output: brief.rendered };
}

export async function handleBriefRebase(
  input: { sessionId: string; item: string; reason: string; by: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let pointer;
  try {
    pointer = await rebaseContextManifest(root, input.sessionId, input.item, input.reason, input.by);
  } catch (err) {
    if (err instanceof RebaseRefusal) throw new CliValidationError("invalid_input", err.message);
    throw err;
  }
  if (format === "json") return { output: JSON.stringify(successEnvelope({ sessionId: input.sessionId, item: input.item, pointer }), null, 2) };
  return {
    output: [
      `Rebased ${input.item} in session ${input.sessionId} onto ${pointer.current}.`,
      `Recovery cleared; recorded as rebased by ${input.by}: ${input.reason}`,
      "The next plan approval must come from a review round started after this rebase.",
    ].join("\n"),
  };
}
