import {
  appendValidationFindings,
  validateProject,
  mergeValidation,
  type ValidationFinding,
  type ValidationResult,
  citingEntitiesOf,
} from "../../core/validation.js";
import { validateIssueSourceRefs } from "../../core/issue-source-ref.js";
import { checkCapabilities } from "../../core/capability.js";
import { CatalogLoadError } from "../../core/catalog.js";
import { capabilityCatalog } from "./capability.js";
import { capabilityScan } from "./term.js";
import { glossaryCatalog, checkTerms, buildTermReferenceIndex } from "../../core/glossary.js";
import { loadRulingsSafe, loadUpwardBoardFor } from "../../core/ruling-loader.js";
import { INTEGRITY_WARNING_TYPES } from "../../core/errors.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { readDuetCoordination } from "../../core/duet-coordination.js";
import { arrangementGateRiskWarnings } from "../../core/arrangement-bounds.js";
import { looksLikeClientTaskId } from "../../models/types.js";
import {
  loadReviewContract,
  readBlockingPolicy,
  reviewContractWarnings,
} from "../../autonomous/review-contract.js";
import { reviewBackendsForClient } from "../../autonomous/stages/codex-native.js";
import { ExitCode, formatValidation } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";
import { HANDOVER_TEMPLATE_MARKER, hasCarriedForwardHeading } from "../../core/handover-template.js";
import { isFilenameAdmitted } from "../../core/handover-brief.js";
import { verifyContainment } from "../../core/readdir-safe.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The coding recipe's default. Named here so the fallback is not a literal. */
const DEFAULT_REVIEW_BACKENDS: readonly string[] = ["codex", "agent"];

/**
 * ISS-1050 interim: surfaces a plan-ack-without-pre-commit-ack risk for any
 * on-disk arrangement matching that shape, regardless of how it got there
 * (hand-edit, future create/update once gates become configurable, or a
 * merge-driver-produced record).
 *
 * Also surfaces `loadArrangementsSafe`'s own per-file loader warnings
 * (codex round-1 finding, verified against source): `cli/commands/
 * conflicts.ts`'s `arrangementWarningsSection` tells the user "Run
 * `storybloq validate` for details" whenever the arrangement scan is
 * incomplete -- that promise was broken without this, since nothing else in
 * `validate` surfaced those warnings (`buildStatusArrangements` is
 * `status`-only, and the reconcile/conflicts front-gates report at their own
 * command's call time, not at `validate`'s).
 */
function arrangementFindings(root: string): ValidationFinding[] {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  const findings: ValidationFinding[] = warnings.map((message) => ({
    level: "warning",
    code: "arrangement_loader_warning",
    message,
    entity: null,
  }));
  for (const arrangement of arrangements) {
    if (arrangement.lifecycle === "active") {
      const { route } = readDuetCoordination(root, arrangement);
      if (route.status !== "current") findings.push({
        level: "warning",
        code: `arrangement_communication_${route.status.replace(/-/g, "_")}`,
        message: `arrangement ${arrangement.id}: communication ${route.status}; verify the return route before dispatch`,
        entity: null,
      });
    }
    for (const warning of arrangementGateRiskWarnings(arrangement.gates)) {
      findings.push({
        level: "warning",
        code: "arrangement_gate_risk",
        message: `arrangement ${arrangement.id}: ${warning}`,
        entity: null,
      });
    }
    // ISS-1117: a closed arrangement's parties are never read by the
    // guard's own matching loop (session-guard.ts skips `lifecycle ===
    // "closed"` arrangements outright), so warning about one is noise, not
    // a live risk -- exempt it, the same way the guard itself does.
    if (arrangement.lifecycle !== "closed") {
      for (const party of arrangement.parties) {
        if (!looksLikeClientTaskId(party.identityAnchor)) {
          findings.push({
            level: "warning",
            code: "arrangement_anchor_unresolvable",
            message: `arrangement ${arrangement.id}: party ${party.role} (${party.client}) identityAnchor does not look like a client task id`,
            entity: null,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * T-476: this is the ONE `validate` call site that loads the ruling
 * side-store and threads it into `validateProject`'s `aux` parameter --
 * every other `validateProject` caller (issue/ticket pre/post-write checks)
 * is unaffected and continues to see pre-T-476 behavior.
 */
/**
 * T-487: the review contract's own findings.
 *
 * The backend list is the EFFECTIVE one, not the raw override array. A project
 * that configured no `reviewBackends` still reviews with codex and agent (the
 * coding recipe's default), and a gate keyed on the raw array left exactly
 * those projects silent -- which is the population that most needs telling.
 */
function reviewContractFindings(ctx: CommandContext): ValidationFinding[] {
  const overrides = (ctx.state.config as { recipeOverrides?: {
    reviewBackends?: readonly string[];
    codexReviewBackends?: readonly string[];
  } }).recipeOverrides;
  const effectiveBackends = reviewBackendsForClient({
    reviewBackends: overrides?.reviewBackends ?? DEFAULT_REVIEW_BACKENDS,
    ...(overrides?.codexReviewBackends === undefined
      ? {}
      : { codexReviewBackends: overrides.codexReviewBackends }),
  });
  const contract = loadReviewContract(ctx.root);
  const { neverBlock } = readBlockingPolicy(ctx.root);
  return reviewContractWarnings(contract, { effectiveBackends, neverBlock }).map((w) => ({
    level: w.level,
    code: w.kind.replace(/-/g, "_"),
    message: w.message,
    entity: null,
  }));
}

/**
 * T-498: the one file read `handover_no_carried_forward` needs. Reads only
 * the NEWEST handover (index 0 of `ctx.state.handoverFilenames`) -- absent,
 * unadmitted, escaping the handovers directory, unreadable, or lacking the
 * marker, this returns false and the check never fires, matching
 * `validateProject`'s "no marker, no claim" contract.
 *
 * Pen byte-review finding (Commit 1): the original version read the file
 * with no admission or containment check at all, unlike every other
 * handover read path. `validateWithRulings`/`handleValidate` stay
 * synchronous (many existing callers and tests depend on that), so this
 * cannot call the async `parseHandoverFilename` used elsewhere -- it uses
 * `verifyContainment` instead, the same sync, already-established
 * realpath-based containment check `readdir-safe.ts` provides, which
 * refuses a name whose resolved target escapes `handoversDir` (a symlink
 * pointing outside it included).
 */
function handoverCarriedForwardAux(ctx: CommandContext): boolean {
  const newest = ctx.state.handoverFilenames[0];
  if (!newest) return false;
  if (!isFilenameAdmitted(newest)) return false;
  if (verifyContainment(ctx.handoversDir, newest) !== null) return false;
  let content: string;
  try {
    content = readFileSync(join(ctx.handoversDir, newest), "utf-8");
  } catch {
    return false;
  }
  if (!content.includes(HANDOVER_TEMPLATE_MARKER)) return false;
  return !hasCarriedForwardHeading(content);
}

function validateWithRulings(ctx: CommandContext): ValidationResult {
  const { rulings, warnings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loadRulingsSafe(ctx.root);
  // T-494: the SECOND half of the reachability condition. `loadProjectUnlocked`
  // skips a corrupt ticket or issue with an integrity warning and keeps going,
  // and `validateRulings` only ever sees the survivors -- so "no ticket or
  // issue cites this ruling" is only sayable when nothing was dropped.
  // `duplicate_id` counts: it means a record lost its slot in the by-id map,
  // and that record's citations are just as invisible as a parse failure's.
  // Scoped to the entities that can CITE, and it has to be. `ctx.warnings`
  // carries integrity warnings for notes, lessons, handovers and arrangements
  // too, and none of those has a `citesRulings` field -- so a single corrupt
  // note used to suppress every reachability finding in the project and report
  // an incomplete scan that was, for this question, complete.
  //
  // `LoadWarning` has no entity kind, only `file`, so the DIRECTORY is the
  // discriminator: the loader scans `.story/tickets/` and `.story/issues/`, so
  // an integrity warning that dropped a citing record carries one of those
  // paths. `filename_classification_mismatch` is deliberately NOT special-cased
  // here: it is not an integrity type, the record still loads, and adding it
  // would be dead code behind the check above.
  //
  // The limit, stated rather than left to be found: a genuinely misfiled ticket
  // sitting under another entity's directory is never loaded as a ticket at
  // all, so no warning attributes it here and its citations are invisible to
  // this question. That is a pre-existing property of directory-scoped loading,
  // not something this predicate can recover.
  const citingEntityLoadComplete = !ctx.warnings.some((w) => {
    if (!(INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type)) return false;
    const path = w.file.replace(/\\/g, "/");
    return path.includes("/tickets/") || path.includes("/issues/")
      || path.startsWith("tickets/") || path.startsWith("issues/");
  });
  const baseResult = validateProject(ctx.state, undefined, {
    // T-520: the orchestrator's board, read once, and only when this project
    // is a linked node with something actually cited.
    // The population is taken from `citingEntitiesOf`, the same function the
    // citation loop iterates, so the read-gate and the loop cannot drift.
    upwardBoard: loadUpwardBoardFor(ctx.root, citingEntitiesOf(ctx.state)),
    rulings,
    unavailableRulingIds: unavailableIds,
    rulingScanCompleteness: scanCompleteness,
    rulingHasUnrecoverableEntries: hasUnrecoverableEntries,
    citingEntityLoadComplete,
    handoverNewestMarkedWithoutCarriedForward: handoverCarriedForwardAux(ctx),
  });
  const merged = mergeValidation(baseResult, ctx.warnings);
  // loadRulingsSafe's own per-file warnings (unreadable/invalid JSON/schema
  // mismatch/etc.) mirror loadArrangementsSafe's plain-string convention,
  // not the main ledger's typed LoadWarning -- surfaced here the same way
  // mergeValidation surfaces the main ledger's loader warnings.
  const loaderFindings: ValidationFinding[] = warnings.map((message) => ({
    level: "warning",
    code: "ruling_loader_warning",
    message,
    entity: null,
  }));
  return appendValidationFindings(merged, [
    ...loaderFindings,
    ...arrangementFindings(ctx.root),
    ...reviewContractFindings(ctx),
  ]);
}

/**
 * T-523: the capability inventory's findings, as validation findings.
 *
 * Only the async validate entry point carries these, and that is deliberate.
 * The sync `handleValidate` is the core the E2E continuity baseline and forty
 * test call sites use; making it async to fit a git subprocess in would change
 * a frozen surface for a check that belongs with the other git-touching one
 * (source-ref provenance) anyway.
 *
 * A STRUCTURAL result is an error: an entry point that does not exist, or a
 * ruling id that resolves to nothing, is a dangling reference of exactly the
 * kind the rest of this file already errors on. A FRESHNESS result is a
 * warning: a stale entry is still true about a commit, it is just no longer
 * known to be true about this one. An INCOMPLETE result is a warning too,
 * because it is a statement about the check rather than about the entry.
 */
async function capabilityFindings(ctx: CommandContext): Promise<ValidationFinding[]> {
  let entries;
  try {
    entries = capabilityCatalog.load(ctx.root).doc.capabilities;
  } catch (err: unknown) {
    if (err instanceof CatalogLoadError) {
      // The catalog exists and cannot be trusted. Reported rather than thrown:
      // a broken capabilities.json must not stop the rest of validate running.
      return [{ level: "error", code: "capability_catalog_unreadable", message: err.message, entity: null }];
    }
    throw err;
  }
  if (entries.length === 0) return [];
  const report = await checkCapabilities(ctx.root, entries, ctx.state, {});
  const findings: ValidationFinding[] = [];
  for (const entry of report.entries) {
    for (const res of entry.results) {
      findings.push({
        level: res.cls === "structural" ? "error" : "warning",
        code: res.code,
        message: `${entry.id}: ${res.detail}`,
        entity: entry.id,
      });
    }
  }
  return findings;
}

/**
 * T-524: the glossary's findings, as validation findings.
 *
 * Same three-way split as the inventory and for the same reasons. STRUCTURAL
 * is an error: a term pointing at a capability or a ruling that does not exist
 * is a dangling reference. THIN is a warning and never an error, because a
 * term filed with only a definition is still a term and holding it out of the
 * ledger would be worse than carrying it. INCOMPLETE is a warning, because it
 * is a statement about the check rather than about the entry.
 *
 * Synchronous, unlike the inventory's: no git subprocess is involved. It lives
 * on the async entry point anyway, beside the inventory findings, so that the
 * two catalogs are reported together rather than one of them appearing in a
 * surface the other does not.
 */
function glossaryFindings(ctx: CommandContext): ValidationFinding[] {
  let entries;
  try {
    entries = glossaryCatalog.load(ctx.root).doc.terms;
  } catch (err: unknown) {
    if (err instanceof CatalogLoadError) {
      // Reported rather than thrown, for the same reason the inventory's is: a
      // broken glossary.json must not stop the rest of validate running.
      return [{ level: "error", code: "glossary_catalog_unreadable", message: err.message, entity: null }];
    }
    throw err;
  }
  if (entries.length === 0) return [];
  // The capability ids come from the OTHER catalog, and a failure to read it
  // leaves the set empty rather than throwing: this function reports on the
  // glossary, and `capabilityFindings` already reports that file's own state.
  // `capabilityScan` is shared with `term check` so both surfaces carry the
  // same unreadable-is-not-absent distinction rather than each rebuilding it.
  const report = checkTerms(entries, buildTermReferenceIndex(ctx.root, capabilityScan(ctx.root)));
  const findings: ValidationFinding[] = [];
  for (const entry of report.entries) {
    for (const res of entry.results) {
      findings.push({
        level: res.cls === "structural" ? "error" : "warning",
        code: res.code,
        message: `${entry.id}: ${res.detail}`,
        entity: entry.id,
      });
    }
  }
  return findings;
}

export function handleValidate(ctx: CommandContext): CommandResult {
  const complete = validateWithRulings(ctx);
  return {
    output: formatValidation(complete, ctx.format),
    exitCode: complete.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}

/** Full validation including Git and working-tree source provenance checks. */
export async function handleValidateWithSourceRefs(
  ctx: CommandContext,
): Promise<CommandResult> {
  const withRulings = validateWithRulings(ctx);
  const sourceFindings = await validateIssueSourceRefs(ctx.root, ctx.state.activeIssues);
  const complete = appendValidationFindings(withRulings, [
    ...sourceFindings,
    ...(await capabilityFindings(ctx)),
    ...glossaryFindings(ctx),
  ]);
  return {
    output: formatValidation(complete, ctx.format),
    exitCode: complete.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}
