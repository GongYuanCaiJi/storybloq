import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import { isClaimStale } from "./claims.js";

export type DoctorSeverity = "error" | "warning" | "info";

export type DoctorRepair =
  | { command: string[] }
  | { manualSteps: string[] }
  | null;

export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  entity: string | null;
  repair: DoctorRepair;
}

export interface DoctorContext {
  root: string;
  cliVersion: string | null;
  isTeamMode: boolean;
  loadWarnings: readonly LoadWarning[];
}

export type DoctorCheck = (state: ProjectState, ctx: DoctorContext) => DoctorFinding[];

export const defaultChecks: DoctorCheck[] = [];

export function registerDoctorCheck(check: DoctorCheck): void {
  defaultChecks.push(check);
}

export interface DoctorResult {
  findings: DoctorFinding[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export function runDoctor(
  state: ProjectState,
  ctx: DoctorContext,
  checks?: DoctorCheck[],
): DoctorResult {
  const activeChecks = checks ?? defaultChecks;
  const findings: DoctorFinding[] = [];

  if (!ctx.isTeamMode) {
    findings.push({
      severity: "info",
      code: "not_team_mode",
      message: "Not a team-mode project. Team doctor checks skipped.",
      entity: null,
      repair: null,
    });
    return buildResult(findings);
  }

  for (const check of activeChecks) {
    findings.push(...check(state, ctx));
  }

  return buildResult(findings);
}

function buildResult(findings: DoctorFinding[]): DoctorResult {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const f of findings) {
    if (f.severity === "error") errorCount++;
    else if (f.severity === "warning") warningCount++;
    else infoCount++;
  }
  return { findings, errorCount, warningCount, infoCount };
}

function effectiveDisplayId(item: { id: string; displayId?: string | null }): string {
  return item.displayId ?? item.id;
}

function checkDuplicateDisplayIds(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string; displayId?: string | null }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    const seen = new Map<string, string[]>();
    for (const item of items) {
      const did = effectiveDisplayId(item);
      let ids = seen.get(did);
      if (!ids) {
        ids = [];
        seen.set(did, ids);
      }
      ids.push(item.id);
    }
    for (const [displayId, ids] of seen) {
      if (ids.length > 1) {
        findings.push({
          severity: "error",
          code: "duplicate_display_id",
          message: `Duplicate ${type} displayId '${displayId}': ${ids.join(", ")}`,
          entity: displayId,
          repair: { command: ["storybloq", "reconcile"] },
        });
      }
    }
  }

  return findings;
}

function checkMissingDisplayId(state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  if (!ctx.isTeamMode) return [];
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string; displayId?: string | null }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    for (const item of items) {
      if (!item.displayId) {
        findings.push({
          severity: "warning",
          code: "missing_display_id",
          message: `${type} ${item.id} has no displayId`,
          entity: item.id,
          repair: { manualSteps: [`Add "displayId" field to ${item.id}`] },
        });
      }
    }
  }

  return findings;
}

function checkUnresolvableRefs(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const t of state.tickets) {
    for (const ref of t.blockedBy) {
      const resolved = state.resolveTicketRef(ref);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Ticket ${effectiveDisplayId(t)} has unresolvable blockedBy ref '${ref}'`,
          entity: t.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
    if (t.parentTicket) {
      const resolved = state.resolveTicketRef(t.parentTicket);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Ticket ${effectiveDisplayId(t)} has unresolvable parentTicket ref '${t.parentTicket}'`,
          entity: t.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
  }

  for (const i of state.issues) {
    for (const ref of i.relatedTickets) {
      const resolved = state.resolveTicketRef(ref);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Issue ${effectiveDisplayId(i)} has unresolvable relatedTickets ref '${ref}'`,
          entity: i.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
  }

  return findings;
}

function checkCliVersion(state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  const minVersion = state.config.team?.minCliVersion;
  if (!minVersion || !ctx.cliVersion) return [];

  if (compareVersionStrings(ctx.cliVersion, minVersion) < 0) {
    return [{
      severity: "warning",
      code: "cli_version_mismatch",
      message: `CLI version ${ctx.cliVersion} is below required ${minVersion}`,
      entity: null,
      repair: { command: ["npm", "update", "-g", "@storybloq/storybloq"] },
    }];
  }
  return [];
}

function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function checkDuplicateCanonicalIds(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) {
        findings.push({
          severity: "error",
          code: "duplicate_canonical_id",
          message: `Duplicate ${type} canonical ID: ${id} appears ${count} times`,
          entity: id,
          repair: { manualSteps: [`Inspect and resolve duplicate files for ${id}`] },
        });
      }
    }
  }

  return findings;
}

function checkLoadWarnings(_state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  return ctx.loadWarnings.map((w) => ({
    severity: "warning" as DoctorSeverity,
    code: `load_warning_${w.type}`,
    message: `${w.file}: ${w.message}`,
    entity: w.file,
    repair: null,
  }));
}

function checkStaleClaims(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const threshold = state.config.team?.claimStalenessHours ?? 48;
  const now = Date.now();

  for (const t of state.tickets) {
    if (!t.claim) continue;

    if (t.status === "complete") {
      findings.push({
        severity: "warning",
        code: "claim_on_complete",
        message: `Ticket ${effectiveDisplayId(t)} is complete but still has claim by ${t.claim.user}`,
        entity: t.id,
        repair: { command: ["storybloq", "ticket", "unclaim", t.id] },
      });
    } else if (isClaimStale(t.claim, threshold, now)) {
      findings.push({
        severity: "warning",
        code: "stale_claim",
        message: `Ticket ${effectiveDisplayId(t)} has stale claim by ${t.claim.user} (since ${t.claim.since})`,
        entity: t.id,
        repair: { command: ["storybloq", "ticket", "unclaim", t.id] },
      });
    }
  }

  return findings;
}

function checkStaleTombstones(state: ProjectState, _ctx: DoctorContext): DoctorFinding[] {
  const now = Date.now();
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const collection of [state.tickets, state.issues, state.notes, state.lessons]) {
    for (const item of collection) {
      const rec = item as Record<string, unknown>;
      if (rec.lifecycle !== "deleted") continue;
      const deletedAt = rec.deletedAt;
      if (typeof deletedAt !== "string") continue;
      const ts = Date.parse(deletedAt);
      if (Number.isNaN(ts) || ts > now) continue;
      if (now - ts >= retentionMs) count++;
    }
  }
  if (count === 0) return [];
  return [{
    severity: "info",
    code: "stale_tombstones",
    message: `${count} tombstoned item(s) past retention period (run storybloq gc)`,
    entity: null,
    repair: { command: ["storybloq", "gc"] },
  }];
}

registerDoctorCheck(checkDuplicateCanonicalIds);
registerDoctorCheck(checkDuplicateDisplayIds);
registerDoctorCheck(checkMissingDisplayId);
registerDoctorCheck(checkUnresolvableRefs);
registerDoctorCheck(checkCliVersion);
registerDoctorCheck(checkLoadWarnings);
registerDoctorCheck(checkStaleClaims);
registerDoctorCheck(checkStaleTombstones);
