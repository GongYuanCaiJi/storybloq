import type { CommandContext, CommandResult } from "../run.js";
import { validateProject } from "../../core/validation.js";
import { INTEGRITY_WARNING_TYPES, type LoadWarning } from "../../core/errors.js";
import type { ProjectState } from "../../core/project-state.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";

interface RepairFix {
  entity: string;
  field: string;
  description: string;
}

export interface RepairResult {
  fixes: RepairFix[];
  error?: string;
  tickets: Ticket[];
  issues: Issue[];
}

/**
 * Compute repairs needed for stale references.
 * Returns the list of fixes and the modified entities ready to write.
 */
export interface RepairOptions {
  canonicalizeRefs?: boolean;
}

export function computeRepairs(
  state: ProjectState,
  warnings: readonly LoadWarning[],
  options?: RepairOptions,
): RepairResult {
  // Refuse when load has integrity warnings (partial load could cause false positives)
  const integrityWarning = warnings.find((w) =>
    (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
  );
  if (integrityWarning) {
    return {
      fixes: [],
      error: `Cannot repair: data integrity issue in ${integrityWarning.file}: ${integrityWarning.message}. Fix the corrupt file first, then retry.`,
      tickets: [],
      issues: [],
    };
  }

  const fixes: RepairFix[] = [];
  const modifiedTickets: Ticket[] = [];
  const modifiedIssues: Issue[] = [];

  const ticketIDs = new Set(state.tickets.map((t) => t.id));
  const allTicketRefs = new Set<string>();
  for (const t of state.tickets) {
    allTicketRefs.add(t.id);
    const did = (t as Record<string, unknown>).displayId as string | undefined;
    if (did) allTicketRefs.add(did);
    for (const prev of ((t as Record<string, unknown>).previousDisplayIds as string[] | undefined) ?? []) {
      allTicketRefs.add(prev);
    }
  }
  const phaseIDs = new Set(state.roadmap.phases.map((p) => {
    const id = p.id;
    return typeof id === "object" && id !== null ? (id as { rawValue?: string }).rawValue ?? String(id) : String(id);
  }));

  function resolveTicketRef(ref: string): { resolved: string; kind: "found" | "missing" | "ambiguous" } {
    const result = state.resolveTicketRef(ref);
    if (result.kind === "found") return { resolved: result.item.id, kind: "found" };
    if (result.kind === "ambiguous") return { resolved: ref, kind: "ambiguous" };
    return { resolved: ref, kind: "missing" };
  }

  for (const ticket of state.tickets) {
    let modified = false;
    let blockedBy = [...ticket.blockedBy];
    let parentTicket = ticket.parentTicket;
    let phase = ticket.phase;

    const newBlockedBy: string[] = [];
    for (const ref of blockedBy) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(ref);
        if (kind === "found") {
          if (resolved !== ref) {
            fixes.push({ entity: ticket.id, field: "blockedBy", description: `Canonicalized: ${ref} -> ${resolved}` });
            modified = true;
          }
          newBlockedBy.push(resolved);
        } else if (kind === "missing") {
          fixes.push({ entity: ticket.id, field: "blockedBy", description: `Removed stale ref: ${ref}` });
          modified = true;
        } else {
          newBlockedBy.push(ref);
        }
      } else if (!allTicketRefs.has(ref)) {
        fixes.push({ entity: ticket.id, field: "blockedBy", description: `Removed stale ref: ${ref}` });
        modified = true;
      } else {
        newBlockedBy.push(ref);
      }
    }
    blockedBy = newBlockedBy;

    if (parentTicket) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(parentTicket);
        if (kind === "found" && resolved !== parentTicket) {
          fixes.push({ entity: ticket.id, field: "parentTicket", description: `Canonicalized: ${parentTicket} -> ${resolved}` });
          parentTicket = resolved;
          modified = true;
        } else if (kind === "missing") {
          fixes.push({ entity: ticket.id, field: "parentTicket", description: `Cleared stale ref: ${parentTicket}` });
          parentTicket = null;
          modified = true;
        }
      } else if (!allTicketRefs.has(parentTicket)) {
        fixes.push({ entity: ticket.id, field: "parentTicket", description: `Cleared stale ref: ${parentTicket}` });
        parentTicket = null;
        modified = true;
      }
    }

    const phaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (phaseRaw && !phaseIDs.has(phaseRaw)) {
      fixes.push({ entity: ticket.id, field: "phase", description: `Cleared stale phase: ${phaseRaw}` });
      phase = null;
      modified = true;
    }

    // ISS-652: completed tickets must not retain autonomous session claim state.
    // The CLI/MCP update path strips it on completion, but tickets completed by
    // direct edit (or before that cleanup existed) keep a stale claimedBySession
    // (or a residual claim). Strip both keys here -- covers explicit-null too,
    // since claimedBySession is nullable+optional and parse retains the key.
    const tRec = ticket as Record<string, unknown>;
    const staleClaimOnComplete = ticket.status === "complete"
      && (Object.prototype.hasOwnProperty.call(tRec, "claimedBySession") || ticket.claim != null);
    if (staleClaimOnComplete) {
      fixes.push({ entity: ticket.id, field: "claim", description: "Cleared stale claim state on completed ticket" });
      modified = true;
    }

    if (modified) {
      let rebuilt: Record<string, unknown> = { ...ticket, blockedBy, parentTicket, phase };
      if (staleClaimOnComplete) {
        const { claim: _claim, claimedBySession: _claimedBySession, ...rest } = rebuilt;
        rebuilt = rest;
      }
      modifiedTickets.push(rebuilt as Ticket);
    }
  }

  for (const issue of state.issues) {
    let modified = false;
    let relatedTickets = [...issue.relatedTickets];
    let phase = issue.phase;

    const newRelated: string[] = [];
    for (const ref of relatedTickets) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(ref);
        if (kind === "found") {
          if (resolved !== ref) {
            fixes.push({ entity: issue.id, field: "relatedTickets", description: `Canonicalized: ${ref} -> ${resolved}` });
            modified = true;
          }
          newRelated.push(resolved);
        } else if (kind === "missing") {
          fixes.push({ entity: issue.id, field: "relatedTickets", description: `Removed stale ref: ${ref}` });
          modified = true;
        } else {
          newRelated.push(ref);
        }
      } else if (!allTicketRefs.has(ref)) {
        fixes.push({ entity: issue.id, field: "relatedTickets", description: `Removed stale ref: ${ref}` });
        modified = true;
      } else {
        newRelated.push(ref);
      }
    }
    relatedTickets = newRelated;

    const issuePhaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (issuePhaseRaw && !phaseIDs.has(issuePhaseRaw)) {
      fixes.push({ entity: issue.id, field: "phase", description: `Cleared stale phase: ${issuePhaseRaw}` });
      phase = null;
      modified = true;
    }

    if (modified) {
      modifiedIssues.push({ ...issue, relatedTickets, phase } as Issue);
    }
  }

  return { fixes, tickets: modifiedTickets, issues: modifiedIssues };
}

export function handleRepair(ctx: CommandContext, dryRun: boolean): CommandResult {
  const { fixes, error } = computeRepairs(ctx.state, ctx.warnings);

  if (error) {
    return { output: error, errorCode: "project_corrupt" };
  }

  if (fixes.length === 0) {
    return { output: "No stale references found. Project is clean." };
  }

  const lines = [`Found ${fixes.length} stale reference(s)${dryRun ? " (dry run)" : ""}:`, ""];
  for (const fix of fixes) {
    lines.push(`- ${fix.entity}.${fix.field}: ${fix.description}`);
  }

  if (dryRun) {
    lines.push("", "Run without --dry-run to apply fixes.");
  }

  return { output: lines.join("\n") };
}
