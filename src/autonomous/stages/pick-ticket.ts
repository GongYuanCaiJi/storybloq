import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "../target-work.js";
import { detectBranchAffinity, checkAffinityMismatch, buildAffinityAnnotation, buildMismatchHandoverInstruction, createTicketBranch, refreshGitWorkingState } from "../branch-affinity.js";
import { canClaim, buildClaim } from "../../core/claims.js";
import { gitUserEmail } from "../git-inspector.js";

/**
 * PICK_TICKET stage -- Claude selects the next ticket to work on.
 *
 * enter(): Candidate list + pick instruction (from handleStart or CompleteStage).
 * report(): Validate ticket exists and is open, advance to PLAN.
 *
 * T-188: When targetWork is non-empty, candidates are constrained to remaining targets.
 */
export class PickTicketStage implements WorkflowStage {
  readonly id = "PICK_TICKET";

  async enter(ctx: StageContext): Promise<StageResult> {
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return {
        action: "retry",
        instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption, then call autonomous_guide with action "report" again.`,
      } as StageAdvance;
    }

    // T-188: Targeted mode -- constrain candidates to remaining targets
    if (isTargetedMode(ctx.state)) {
      const remaining = getRemainingTargets(ctx.state);
      if (remaining.length === 0) {
        return { action: "goto", target: "COMPLETE" };
      }

      // Use firstReady as the stuck indicator -- handles all cases:
      // external blockers, mutual-blocking cycles, missing tickets, resolved issues
      const { text: candidatesText, firstReady } = buildTargetedCandidatesText(remaining, projectState);
      if (!firstReady) {
        return {
          action: "goto",
          target: "HANDOVER",
          result: {
            instruction: buildTargetedStuckHandover(candidatesText, ctx.state.sessionId),
            reminders: [],
            transitionedFrom: "PICK_TICKET",
          },
        } as StageResult;
      }

      const precomputed = { text: candidatesText, firstReady };
      const targetedInstruction = buildTargetedPickInstruction(remaining, projectState, ctx.state.sessionId, precomputed);
      return {
        instruction: [
          "# Pick a Target Item",
          "",
          `${remaining.length} of ${ctx.state.targetWork.length} target(s) remaining.`,
          "",
          targetedInstruction,
        ].join("\n"),
        reminders: [
          "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a target item.",
          "Do NOT ask the user for confirmation.",
          "You are in targeted auto mode -- pick ONLY from the listed items.",
        ],
      };
    }

    // Standard auto mode -- browse full roadmap
    const { nextTickets } = await import("../../core/queries.js");
    const candidates = nextTickets(projectState, 5);

    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } & Record<string, unknown> }, i: number) =>
        `${i + 1}. **${(c.ticket.displayId as string | undefined) ?? c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
      ).join("\n");
    }

    // T-328: Branch affinity annotation
    const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
    const { warningText } = buildAffinityAnnotation(affinity);
    if (warningText) {
      candidatesText = warningText + "\n\n" + candidatesText;
    }

    // ISS-084: Surface ALL open issues (severity affects display order, not work-remaining check)
    const allOpenIssues = projectState.issues.filter(i => i.status === "open");
    const highIssues = allOpenIssues.filter(i => i.severity === "critical" || i.severity === "high");
    const otherIssues = allOpenIssues.filter(i => i.severity !== "critical" && i.severity !== "high");
    let issuesText = "";
    if (highIssues.length > 0) {
      issuesText = "\n\n## Open Issues (high+ severity)\n\n" + highIssues.map(
        (i, idx) => `${idx + 1}. **${(i as Record<string, unknown>).displayId as string | undefined ?? i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }
    if (otherIssues.length > 0) {
      issuesText += "\n\n## Open Issues (medium/low)\n\n" + otherIssues.map(
        (i, idx) => `${idx + 1}. **${(i as Record<string, unknown>).displayId as string | undefined ?? i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;
    const hasIssues = allOpenIssues.length > 0;

    // ISS-075: If nothing left to do, route to COMPLETE (which handles HANDOVER/postComplete)
    if (!topCandidate && candidates.kind !== "found" && !hasIssues) {
      return { action: "goto", target: "COMPLETE" };
    }

    return {
      instruction: [
        "# Pick a Ticket or Issue",
        "",
        "## Ticket Candidates",
        "",
        candidatesText || "No ticket candidates found.",
        issuesText,
        "",
        topCandidate
          ? `Pick **${(topCandidate.ticket as Record<string, unknown>).displayId as string | undefined ?? topCandidate.ticket.id}** (highest priority) or an open issue by calling \`storybloq_autonomous_guide\` now:`
          : hasIssues
            ? `Pick an issue to fix by calling \`storybloq_autonomous_guide\` now:`
            : "Pick a ticket by calling `storybloq_autonomous_guide` now:",
        '```json',
        topCandidate
          ? `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
          : `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
        '```',
        ...(hasIssues ? [
          "",
          "Or to fix an issue:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_picked", "issueId": "${(highIssues[0] ?? allOpenIssues[0]).id}" } }`,
          '```',
        ] : []),
      ].join("\n"),
      reminders: [
        "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a ticket or issue.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    // T-153: Accept issueId for issue-fix flow
    const issueId = report.issueId;
    if (issueId) {
      return this.handleIssuePick(ctx, issueId);
    }

    const ticketId = report.ticketId;
    if (!ticketId) {
      return { action: "retry", instruction: "report.ticketId or report.issueId is required." };
    }

    // T-188: Enforce target list in targeted mode
    const targetReject = this.enforceTargetList(ctx, ticketId);
    if (targetReject) return targetReject;

    // T-328: Branch affinity mismatch blocking
    // Skip when: targeted mode (already handled above), or per-ticket branching (Part 2)
    if (!isTargetedMode(ctx.state) && ctx.state.resolvedBranchStrategy !== "per-ticket") {
      const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
      const mismatch = checkAffinityMismatch(affinity, ticketId);
      if (mismatch.blocked) {
        return {
          action: "goto",
          target: "HANDOVER",
          result: {
            instruction: buildMismatchHandoverInstruction(affinity, ticketId, ctx.state.sessionId),
            reminders: [],
            transitionedFrom: "PICK_TICKET",
          },
        };
      }
    }

    // Validate ticket
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption.` };
    }
    const ticket = projectState.ticketByID(ticketId);
    if (!ticket) {
      return { action: "retry", instruction: `Ticket ${ticketId} not found. Pick a valid ticket.` };
    }
    if (projectState.isBlocked(ticket)) {
      return { action: "retry", instruction: `Ticket ${ticketId} is blocked. Pick an unblocked ticket.` };
    }
    // ISS-027: Reject non-open tickets unless claimed by this session
    if (ticket.status !== "open") {
      const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
      if (!(ticket.status === "inprogress" && ticketClaim === ctx.state.sessionId)) {
        return { action: "retry", instruction: `Ticket ${ticketId} is ${ticket.status} — pick an open ticket.` };
      }
    }

    // T-375: Claim check -- reject tickets claimed by others
    const email = await gitUserEmail(ctx.root);
    if (ticket.claim) {
      if (!email) {
        return { action: "retry", instruction: `Ticket ${ticketId} is claimed by ${ticket.claim.user}. Configure git user.email to verify identity, or pick a different ticket.` };
      }
      const claimResult = canClaim(ticket, email, ctx.state.git?.branch ?? "unknown");
      if (!claimResult.allowed) {
        return { action: "retry", instruction: `Ticket ${ticketId} is claimed by ${claimResult.claimedBy} on branch ${ticket.claim.branch}. Pick a different ticket.` };
      }
    }

    // T-328 Part 2: Per-ticket branch creation
    if (ctx.state.resolvedBranchStrategy === "per-ticket") {
      const headResult = await import("../git-inspector.js").then(m => m.gitHead(ctx.root));
      if (!headResult.ok || headResult.data.branch === null) {
        return { action: "retry", instruction: `branchStrategy is "per-ticket" but ${!headResult.ok ? "git is unavailable" : "HEAD is detached"}. Switch to a branch or set branchStrategy to "none".` };
      }
      const result = await createTicketBranch(
        ctx.root,
        ctx.state.git ?? { branch: null, mergeBase: null },
        { id: ticket.id, displayId: (ticket as Record<string, unknown>).displayId as string | undefined, title: ticket.title },
        "story",
      );
      if (!result.ok) {
        return { action: "retry", instruction: `Branch creation failed: ${result.message}. Fix the issue and retry.` };
      }
      if (result.data.created || result.data.branchName !== ctx.state.git?.branch) {
        const refreshed = await refreshGitWorkingState(ctx.root);
        if (!refreshed) {
          return { action: "retry", instruction: `Branch "${result.data.branchName}" was checked out but git state refresh failed. Run \`git status\` and retry.` };
        }
        ctx.updateDraft({
          git: {
            ...ctx.state.git,
            branch: refreshed.branch,
            expectedHead: refreshed.expectedHead,
            baseline: refreshed.baseline,
          },
        });
      }
    }

    // Clean up stale plan from previous ticket (ISS-029)
    const planPath = join(ctx.dir, "plan.md");
    try { if (existsSync(planPath)) unlinkSync(planPath); } catch { /* best-effort */ }

    // T-375: Build claim using final branch (after per-ticket branch creation)
    const finalBranch = ctx.state.git?.branch ?? "unknown";
    const claimObj = email ? buildClaim(email, finalBranch, new Date().toISOString()) : undefined;
    const ticketDisplayId = (ticket as Record<string, unknown>).displayId as string | undefined;
    const ticketLabel = ticketDisplayId ?? ticket.id;

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: { id: ticket.id, displayId: ticketDisplayId, title: ticket.title, claimed: true },
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
      ticketStartedAt: new Date().toISOString(),
      ...(claimObj ? { pendingTicketClaim: claimObj } : {}),
    });

    // Produce PLAN instruction (advance with result for hybrid dispatch)
    return {
      action: "advance",
      result: {
        instruction: [
          `# Plan for ${ticketLabel}: ${ticket.title}`,
          "",
          ticket.description ? `## Ticket Description\n\n${ticket.description}` : "",
          "",
          `Write an implementation plan for this ticket. Save it to \`.story/sessions/${ctx.state.sessionId}/plan.md\`.`,
          "",
          "When done, call `storybloq_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Write the plan as a markdown file — do NOT use Claude Code's plan mode.",
          "Do NOT ask the user for approval.",
        ],
        transitionedFrom: "PICK_TICKET",
      },
    };
  }

  // T-153: Handle issue pick -- validate and route to ISSUE_FIX
  private async handleIssuePick(ctx: StageContext, issueId: string): Promise<StageAdvance> {
    // T-188: Enforce target list in targeted mode
    const targetReject = this.enforceTargetList(ctx, issueId);
    if (targetReject) return targetReject;

    // T-328: Branch affinity mismatch blocking
    if (!isTargetedMode(ctx.state) && ctx.state.resolvedBranchStrategy !== "per-ticket") {
      const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
      const mismatch = checkAffinityMismatch(affinity, issueId);
      if (mismatch.blocked) {
        return {
          action: "goto",
          target: "HANDOVER",
          result: {
            instruction: buildMismatchHandoverInstruction(affinity, issueId, ctx.state.sessionId),
            reminders: [],
            transitionedFrom: "PICK_TICKET",
          },
        };
      }
    }

    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption.` };
    }
    const issue = projectState.issues.find(i => i.id === issueId);

    if (!issue) {
      return { action: "retry", instruction: `Issue ${issueId} not found. Pick a valid issue or ticket.` };
    }
    // T-188: Targeted mode allows inprogress issues (resume from prior session)
    const targeted = isTargetedMode(ctx.state);
    if (issue.status !== "open" && !(targeted && issue.status === "inprogress")) {
      return { action: "retry", instruction: `Issue ${issueId} is ${issue.status}. Pick an open issue.` };
    }

    // T-328 Part 2: Per-ticket branch creation for issues
    if (ctx.state.resolvedBranchStrategy === "per-ticket") {
      const headResult = await import("../git-inspector.js").then(m => m.gitHead(ctx.root));
      if (!headResult.ok || headResult.data.branch === null) {
        return { action: "retry", instruction: `branchStrategy is "per-ticket" but ${!headResult.ok ? "git is unavailable" : "HEAD is detached"}. Switch to a branch or set branchStrategy to "none".` };
      }
      const result = await createTicketBranch(
        ctx.root,
        ctx.state.git ?? { branch: null, mergeBase: null },
        { id: issue.id, displayId: (issue as Record<string, unknown>).displayId as string | undefined, title: issue.title },
        "fix",
      );
      if (!result.ok) {
        return { action: "retry", instruction: `Branch creation failed: ${result.message}. Fix the issue and retry.` };
      }
      if (result.data.created || result.data.branchName !== ctx.state.git?.branch) {
        const refreshed = await refreshGitWorkingState(ctx.root);
        if (!refreshed) {
          return { action: "retry", instruction: `Branch "${result.data.branchName}" was checked out but git state refresh failed. Run \`git status\` and retry.` };
        }
        ctx.updateDraft({
          git: {
            ...ctx.state.git,
            branch: refreshed.branch,
            expectedHead: refreshed.expectedHead,
            baseline: refreshed.baseline,
          },
        });
      }
    }

    // ISS-090: Mark issue as inprogress with pendingProjectMutation for crash recovery
    // ISS-112: Include expectedCurrent for 3-way recovery check (matches ticket_update pattern)
    const transitionId = `issue-pick-${issueId}-${Date.now()}`;
    ctx.writeState({
      pendingProjectMutation: { type: "issue_update", target: issueId, field: "status", value: "inprogress", expectedCurrent: issue.status, transitionId },
    });
    try {
      const { handleIssueUpdate } = await import("../../cli/commands/issue.js");
      await handleIssueUpdate(issueId, { status: "inprogress" }, "json", ctx.root);
    } catch { /* best-effort -- don't block on status update */ }
    ctx.writeState({ pendingProjectMutation: null });

    ctx.updateDraft({
      currentIssue: { id: issue.id, displayId: (issue as Record<string, unknown>).displayId as string | undefined, title: issue.title, severity: issue.severity },
      ticket: undefined,
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
    });

    return { action: "goto", target: "ISSUE_FIX" };
  }

  // T-188: Shared target list enforcement for report() and handleIssuePick()
  private enforceTargetList(ctx: StageContext, pickedId: string): StageAdvance | null {
    if (!isTargetedMode(ctx.state)) return null;
    const remaining = getRemainingTargets(ctx.state);
    if (remaining.length === 0) {
      return { action: "goto", target: "COMPLETE" };
    }
    if (!remaining.includes(pickedId)) {
      return { action: "retry", instruction: `${pickedId} is not a remaining target. Pick from: ${remaining.join(", ")}.` };
    }
    return null;
  }
}
