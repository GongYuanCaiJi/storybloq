/**
 * T-508: the ledger sidebar Mod's projection of `.story/`.
 *
 * WHY THIS FILE IS HERE AND NOT IN src/core. A Claude Code hooks module
 * "imports its own files by relative path and 'claude-code', nothing else":
 * `claude plugin validate` refuses an import from outside the plugin's folder
 * and refuses any `node:` import, and `src/core`'s status projection reaches
 * both. So the numbers are computed here, in a file the client will load, and
 * `test/plugin/sidebar-projection.test.ts` asserts they equal the ones
 * `storybloq status --compact` prints for the same fixture `.story/`. That
 * test is the whole of "do not fork the projection": there is one set of
 * rules, and two implementations that are held equal.
 *
 * Every rule below is the CLI's, reproduced deliberately:
 *   - active means `lifecycle` absent or "active"; deleted is out of every count
 *   - a ticket named as another's `parentTicket` is an umbrella and never a leaf
 *   - counts are over leaves only, so an umbrella's own status is ignored
 *   - a phase's status aggregates its leaves: all complete is complete, any
 *     complete or in progress is in progress, otherwise not started
 *   - a blocker reference resolves by id, then displayId, then a previous
 *     displayId; one that is missing or ambiguous counts as blocking, which is
 *     the conservative reading the CLI takes
 *
 * Pure: no imports, no clock, no I/O. The caller reads the files (`$.fs`) and
 * caches what `extractRecord` returns; this module only counts.
 */

/** How long a title may be once cached. The store holds 4 MiB for the whole plugin. */
const TITLE_CAP = 80;

/** The severities the ledger uses, in the order the sidebar shows them. */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type LedgerKind = "ticket" | "issue";

export type PhaseStatus = "complete" | "inprogress" | "notstarted";

/** A ticket, reduced to the fields the sidebar counts or shows. */
export interface SidebarTicket {
  readonly kind: "ticket";
  readonly id: string;
  readonly displayId: string;
  readonly previousDisplayIds: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly phase: string | null;
  readonly parentTicket: string | null;
  readonly blockedBy: readonly string[];
  readonly lifecycle: string | null;
  readonly order: number;
}

/** An issue, reduced the same way. */
export interface SidebarIssue {
  readonly kind: "issue";
  readonly id: string;
  readonly displayId: string;
  readonly previousDisplayIds: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly severity: string;
  readonly lifecycle: string | null;
}

export type SidebarRecord = SidebarTicket | SidebarIssue;

export interface SidebarPhase {
  readonly id: string;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly leafCount: number;
}

export interface SidebarTicketRef {
  readonly id: string;
  readonly title: string;
  readonly phase: string | null;
}

export interface SidebarInput {
  readonly project: string;
  readonly phases: readonly { readonly id: string; readonly name: string }[];
  readonly tickets: readonly SidebarTicket[];
  readonly issues: readonly SidebarIssue[];
  readonly handoverFilenames: readonly string[];
}

export interface SidebarProjection {
  readonly project: string;
  readonly totalTickets: number;
  readonly completeTickets: number;
  readonly openTickets: number;
  readonly blockedTickets: number;
  readonly openIssues: number;
  readonly issuesBySeverity: Readonly<Record<string, number>>;
  readonly phases: readonly SidebarPhase[];
  readonly currentPhase: SidebarPhase | null;
  readonly inProgressTickets: readonly SidebarTicketRef[];
  readonly latestHandover: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

/**
 * Reads one ledger file's text into the fields the sidebar keeps, or null when
 * the text is not a record of that kind.
 *
 * Null rather than a throw: the Mod reads whatever is in the directory, and a
 * half-written file during someone else's transaction must cost one row, not
 * the pane. The CLI's loader takes the same line (it skips a corrupt entry with
 * a warning), so skipping here keeps the two projections equal.
 *
 * The title is truncated at extraction, not at render: this is what goes into
 * `$.store`, and a ledger of two thousand untruncated records would spend the
 * store's whole 4 MiB on prose the pane never shows.
 */
export function extractRecord(kind: LedgerKind, text: string): SidebarRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const id = asString(raw["id"]);
  const status = asString(raw["status"]);
  if (id === null || status === null) return null;

  const displayIdRaw = asString(raw["displayId"]);
  const displayId = displayIdRaw !== null && displayIdRaw.trim() !== "" ? displayIdRaw.trim() : id;
  const title = (asString(raw["title"]) ?? "").slice(0, TITLE_CAP);
  const lifecycle = asString(raw["lifecycle"]);
  const previousDisplayIds = asStringArray(raw["previousDisplayIds"]);

  if (kind === "issue") {
    const severity = asString(raw["severity"]);
    if (severity === null) return null;
    return { kind: "issue", id, displayId, previousDisplayIds, title, status, severity, lifecycle };
  }

  const orderRaw = raw["order"];
  return {
    kind: "ticket",
    id,
    displayId,
    previousDisplayIds,
    title,
    status,
    phase: asString(raw["phase"]),
    parentTicket: asString(raw["parentTicket"]),
    blockedBy: asStringArray(raw["blockedBy"]),
    lifecycle,
    order: typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : 0,
  };
}

function isActive(record: { readonly lifecycle: string | null }): boolean {
  return record.lifecycle === null || record.lifecycle === "active";
}

/** The CLI's three-step reference resolution, over every ticket including deleted ones. */
type Resolution =
  | { readonly kind: "found"; readonly item: SidebarTicket }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "missing" };

function buildResolver(tickets: readonly SidebarTicket[]): (ref: string) => Resolution {
  const byId = new Map<string, SidebarTicket>();
  const byDisplay = new Map<string, SidebarTicket[]>();
  const byPrev = new Map<string, SidebarTicket[]>();
  for (const t of tickets) {
    // First wins, as the CLI's index does.
    if (!byId.has(t.id)) byId.set(t.id, t);
    const displayKey = t.displayId.trim() === "" ? t.id : t.displayId.trim();
    const atDisplay = byDisplay.get(displayKey);
    if (atDisplay) atDisplay.push(t);
    else byDisplay.set(displayKey, [t]);
    for (const prev of t.previousDisplayIds) {
      const trimmed = prev.trim();
      if (trimmed === "") continue;
      const atPrev = byPrev.get(trimmed);
      if (atPrev) atPrev.push(t);
      else byPrev.set(trimmed, [t]);
    }
  }
  return (ref: string): Resolution => {
    const hit = byId.get(ref);
    if (hit) return { kind: "found", item: hit };
    const display = byDisplay.get(ref);
    if (display && display.length === 1) return { kind: "found", item: display[0]! };
    if (display && display.length > 1) return { kind: "ambiguous" };
    const prev = byPrev.get(ref);
    if (prev && prev.length === 1) return { kind: "found", item: prev[0]! };
    if (prev && prev.length > 1) return { kind: "ambiguous" };
    return { kind: "missing" };
  };
}

function aggregateStatus(leaves: readonly SidebarTicket[]): PhaseStatus {
  if (leaves.length === 0) return "notstarted";
  if (leaves.every((t) => t.status === "complete")) return "complete";
  const anyProgress = leaves.some((t) => t.status === "inprogress");
  const anyComplete = leaves.some((t) => t.status === "complete");
  return anyProgress || anyComplete ? "inprogress" : "notstarted";
}

/**
 * The numbers the pane draws, from records the caller already read.
 *
 * Held equal to `buildCompactStatusData` by the repo's own test; change a rule
 * here without changing it there and that test goes red.
 */
export function projectSidebar(input: SidebarInput): SidebarProjection {
  const resolve = buildResolver(input.tickets);

  const activeTickets = input.tickets.filter(isActive);
  const activeIssues = input.issues.filter(isActive);

  // An umbrella is any ticket another active ticket names as its parent. The
  // reference is normalized first, so a parent named by displayId still makes
  // that ticket an umbrella.
  const umbrellaIds = new Set<string>();
  for (const t of activeTickets) {
    if (t.parentTicket === null) continue;
    const resolved = resolve(t.parentTicket);
    umbrellaIds.add(resolved.kind === "found" ? resolved.item.id : t.parentTicket);
  }

  const leaves = activeTickets.filter((t) => !umbrellaIds.has(t.id));
  const completeTickets = leaves.filter((t) => t.status === "complete").length;

  const isBlocked = (t: SidebarTicket): boolean => {
    for (const ref of t.blockedBy) {
      const resolved = resolve(ref);
      if (resolved.kind === "missing" || resolved.kind === "ambiguous") return true;
      if (resolved.item.lifecycle !== "deleted" && resolved.item.status !== "complete") return true;
    }
    return false;
  };

  const phases: SidebarPhase[] = input.phases.map((p) => {
    const ofPhase = leaves.filter((t) => t.phase === p.id);
    return { id: p.id, name: p.name, status: aggregateStatus(ofPhase), leafCount: ofPhase.length };
  });

  const issuesBySeverity: Record<string, number> = {};
  for (const severity of SEVERITIES) issuesBySeverity[severity] = 0;
  let openIssues = 0;
  for (const i of activeIssues) {
    if (i.status === "resolved") continue;
    openIssues += 1;
    issuesBySeverity[i.severity] = (issuesBySeverity[i.severity] ?? 0) + 1;
  }

  const inProgressTickets = leaves
    .filter((t) => t.status === "inprogress")
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ id: t.displayId, title: t.title, phase: t.phase }));

  const handovers = [...input.handoverFilenames].sort();
  const latestHandover = handovers.length > 0 ? handovers[handovers.length - 1]! : null;

  return {
    project: input.project,
    totalTickets: leaves.length,
    completeTickets,
    openTickets: leaves.length - completeTickets,
    blockedTickets: leaves.filter((t) => t.status !== "complete" && isBlocked(t)).length,
    openIssues,
    issuesBySeverity,
    phases,
    currentPhase:
      phases.find((p) => p.status === "inprogress")
      ?? phases.find((p) => p.status === "notstarted")
      ?? null,
    inProgressTickets,
    latestHandover,
  };
}
