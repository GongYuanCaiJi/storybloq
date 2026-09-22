import { formatExport, escapeMarkdownDocumentStrict } from "../../core/output-formatter.js";
import { CatalogLoadError } from "../../core/catalog.js";
import { capabilityCatalog, catalogPath, catalogText } from "./capability.js";
import type { Capability } from "../../models/capability.js";
import { glossaryCatalog } from "../../core/glossary.js";
import type { Term } from "../../models/glossary.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import { loadRulingsSafe } from "../../core/ruling-loader.js";
import { buildCitationResolutionContext, buildSuccessorIndex, resolveCitation } from "../../core/ruling.js";
import { proposalsFor } from "../../core/ruling-lifecycle.js";
import { formatDecisionsListing, type DecisionsListingItem } from "../../core/decisions-listing.js";
import type { Ruling } from "../../models/ruling.js";

/**
 * T-523: the capability inventory in the self-contained project document.
 *
 * The status rendered here is the STORED one and the section says so. An
 * export is a document handed to somebody else, so it must not vary with the
 * working tree it happens to be produced from or spend thirty seconds of git
 * subprocesses first. What it carries instead is strictly more than a status
 * word: each entry's checkpoint sha and date, which is the evidence a reader
 * would need to judge the status themselves, plus the command that recomputes
 * it.
 *
 * ESCAPING IS DOCUMENT-GRADE, not inline. `escapeMarkdownInline` guards only
 * line-leading markers, which is right for a plain-text sink and wrong here:
 * an export is opened in a Markdown viewer, so a contract or a summary
 * containing raw HTML or a `[text](url)` whose visible text and destination
 * disagree would render as the attacker wrote it. `escapeMarkdownDocument` is
 * the helper whose own docblock names `storybloq export` as its reason to
 * exist, and the Strict form additionally breaks a bare autolink, which the
 * non-strict form leaves clickable.
 *
 * Every field goes through the capability surface's choke points first
 * (`catalogText`, `catalogPath`), which sanitize control, line-separator and
 * bidi characters and then apply this escape: the document escape handles
 * Markdown, HTML and links and does not touch ESC, so an export printed to a
 * terminal would otherwise run whatever escape sequences a committed catalog
 * carries. The id, status, sha and date are regex-constrained and could not
 * carry a payload, but they go through it too: "which fields are safe" is a
 * judgement that rots the moment a schema loosens, and on this charset both
 * steps are no-ops anyway.
 *
 * `--phase` exports do not carry it. The inventory is project-wide and has no
 * phase to be scoped by; including it whole under one phase would misrepresent
 * it as that phase's.
 */
function capabilitySection(root: string): { md: string[]; json: unknown } {
  let entries: readonly Capability[];
  try {
    entries = capabilityCatalog.load(root).doc.capabilities;
  } catch (err: unknown) {
    if (err instanceof CatalogLoadError) {
      return {
        md: ["## Capabilities", "", `_Not included: ${escapeMarkdownDocumentStrict(err.message)}._`],
        json: { unavailable: err.message },
      };
    }
    throw err;
  }
  if (entries.length === 0) {
    return { md: ["## Capabilities", "", "_No capability inventory yet._"], json: [] };
  }
  const md = [
    `## Capabilities (${entries.length})`,
    "",
    "_Status and checkpoint are as stored. Run `storybloq capability check` to recompute freshness against HEAD._",
  ];
  const text = (value: string): string => catalogText(value, escapeMarkdownDocumentStrict);
  const path = (value: string): string => catalogPath(value, escapeMarkdownDocumentStrict);
  for (const cap of entries) {
    md.push("", `### ${text(cap.name)} (${text(cap.id)}) [${text(cap.status)}]`);
    md.push("", text(cap.summary));
    md.push("", `- Contract: ${text(cap.contract)}`);
    md.push(`- Entry points: ${cap.entryPoints.map((p) => path(p)).join(", ")}`);
    if (cap.example) md.push(`- Example: ${text(cap.example)}`);
    if (cap.rulings?.length) md.push(`- Rulings: ${cap.rulings.map((r) => text(r)).join(", ")}`);
    if (cap.items?.length) md.push(`- Items: ${cap.items.map((i) => text(i)).join(", ")}`);
    md.push(`- Checked at: ${text(cap.checkedAt.sha.slice(0, 12))} (${text(cap.checkedAt.date)})`);
  }
  return { md, json: entries };
}

/**
 * Splices a section into the JSON envelope rather than concatenating it.
 * `applyHandlerWarnings` in run.ts already adds a key to this same envelope the
 * same way, so a second writer doing it differently would be the drift.
 *
 * Takes the KEY as an argument since T-524: the glossary splices into the same
 * envelope, and a second copy of this function differing only in one string
 * literal is how two writers come to disagree about the envelope's shape.
 */
export function withSectionJson(output: string, key: string, value: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  const envelope = parsed as Record<string, unknown>;
  const data = envelope.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return output;
  return JSON.stringify({ ...envelope, data: { ...(data as Record<string, unknown>), [key]: value } }, null, 2);
}

/**
 * T-524: the glossary in the same document.
 *
 * Same escaping discipline as the inventory above, and for the same reason:
 * this is a Markdown document handed to somebody else, so every stored string
 * goes through the sanitizing choke point and then the document-grade escape.
 *
 * No status to render and no freshness caveat to add: a term is true or it is
 * wrong, and neither is something a commit makes stale. What the section does
 * carry is the advisory line, because a reader who takes a glossary for a
 * naming rule has read it wrong.
 *
 * `--phase` exports do not carry it, for the inventory's reason exactly: the
 * glossary is project-wide and has no phase to be scoped by.
 */
function glossarySection(root: string): { md: string[]; json: unknown } {
  let entries: readonly Term[];
  try {
    entries = glossaryCatalog.load(root).doc.terms;
  } catch (err: unknown) {
    if (err instanceof CatalogLoadError) {
      return {
        md: ["## Glossary", "", `_Not included: ${escapeMarkdownDocumentStrict(err.message)}._`],
        json: { unavailable: err.message },
      };
    }
    throw err;
  }
  if (entries.length === 0) {
    return { md: ["## Glossary", "", "_No glossary yet._"], json: [] };
  }
  const text = (value: string): string => catalogText(value, escapeMarkdownDocumentStrict);
  const sorted = [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  const md = [
    `## Glossary (${sorted.length})`,
    "",
    "_Terms are advisory: they say what a word means here, and nothing renames, rewrites or refuses on one._",
  ];
  for (const entry of sorted) {
    md.push("", `### ${text(entry.term)} (${text(entry.id)})${entry.core === true ? " [core]" : ""}`);
    md.push("", text(entry.definition));
    if (entry.distinction) md.push("", `- Not: ${text(entry.distinction)}`);
    if (entry.aliases?.length) md.push(`- Also called: ${entry.aliases.map((a) => text(a)).join(", ")}`);
    if (entry.capabilities?.length) md.push(`- Capabilities: ${entry.capabilities.map((c) => text(c)).join(", ")}`);
    if (entry.rulings?.length) md.push(`- Rulings: ${entry.rulings.map((r) => text(r)).join(", ")}`);
  }
  return { md, json: sorted };
}

/**
 * T-522 plan section 6: the Decisions section. `--all` renders every record.
 * A phase export keeps, for every citation of the phase's items: the cited
 * record, every chain member through the effective successor, all competing
 * successors of a branched node, any uncertain successor an indeterminate
 * result names (with the diagnostic), and the proposals `proposedFor` the
 * phase's items. Each kept record renders once, under its lifecycle. Loader
 * warnings go in the section header, so a reader knows what the listing
 * could not see.
 */
export function decisionsSection(
  root: string,
  items: readonly DecisionsListingItem[],
  scope: "all" | "phase",
): { md: string[]; json: unknown } {
  const loaded = loadRulingsSafe(root);
  const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries, lifecycleById } = loaded;
  const warnings = [...loaded.warnings];
  const index = buildSuccessorIndex(rulings);
  const text = (value: string): string => escapeMarkdownDocumentStrict(value);
  let kept: readonly Ruling[];
  const diagnostics: string[] = [];
  if (scope === "all") {
    kept = rulings;
  } else {
    const byId = new Map(rulings.map((r) => [r.id, r]));
    const rulingCtx = buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
    const keep = new Set<string>();
    const add = (id: string): void => { if (byId.has(id)) keep.add(id); };
    // Codex (2026-09-22) finding: resolveCitation carries no traversed chain
    // on an indeterminate result, so the known prefix (A -> B, then an
    // uncertain C on B) was dropped. Walk the successor index from the cited
    // record over BOTH edge kinds, cycle-safe: that reaches every chain
    // member, every competing successor of a branched node and every
    // uncertain successor, whatever the resolution status turns out to be.
    const walk = (from: string): void => {
      const frontier = [from];
      const seen = new Set<string>();
      while (frontier.length > 0) {
        const id = frontier.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        add(id);
        for (const next of index.successorsByTarget.get(id) ?? []) frontier.push(next);
        for (const next of index.uncertainSuccessorsByTarget.get(id) ?? []) frontier.push(next);
      }
    };
    for (const item of items) {
      for (const citedId of item.citesRulings ?? []) {
        walk(citedId);
        const res = resolveCitation(citedId, rulingCtx);
        switch (res.status) {
          case "resolved":
          case "cycle":
            break;
          case "branch":
            diagnostics.push(`${item.id} cites ${citedId}: branched, competing successors ${res.competingSuccessors.join(", ")}; no single ruling is current`);
            break;
          case "indeterminate":
            for (const id of res.ids ?? []) add(id);
            diagnostics.push(`${item.id} cites ${citedId}: indeterminate (${res.reason}${res.ids?.length ? `: ${res.ids.join(", ")}` : ""})`);
            break;
          case "nonaccepted":
            diagnostics.push(`${item.id} cites ${citedId}: ${res.lifecycle}, binds nothing`);
            break;
          case "missing":
            diagnostics.push(`${item.id} cites ${citedId}: no such ruling`);
            break;
          case "unreadable":
            diagnostics.push(`${item.id} cites ${citedId}: unreadable`);
            break;
        }
      }
      for (const proposal of proposalsFor(rulings, item.id)) keep.add(proposal.id);
    }
    kept = rulings.filter((r) => keep.has(r.id));
  }
  const md: string[] = [scope === "all" ? `## Decisions (${kept.length})` : `## Decisions (${kept.length}, cited by this phase)`];
  for (const w of warnings) md.push(`_Ruling scan: ${text(w)}_`);
  for (const d of diagnostics) md.push(`_Citation: ${text(d)}_`);
  md.push("", formatDecisionsListing(kept, lifecycleById, { index }, items));
  const json = {
    rulings: kept.map((r) => ({ ...r, lifecycle: lifecycleById.get(r.id) ?? null })),
    warnings,
    diagnostics,
  };
  return { md, json };
}

export function handleExport(
  ctx: CommandContext,
  mode: "all" | "phase",
  phaseId: string | null,
): CommandResult {
  if (mode === "phase") {
    if (!phaseId) {
      throw new CliValidationError("invalid_input", "Missing --phase value");
    }
    // Verify phase exists
    const phase = ctx.state.roadmap.phases.find((p) => p.id === phaseId);
    if (!phase) {
      throw new CliValidationError("not_found", `Phase "${phaseId}" not found in roadmap`);
    }
  }

  const output = formatExport(ctx.state, mode, phaseId, ctx.format);
  const items: DecisionsListingItem[] =
    mode === "all"
      ? [...ctx.state.tickets, ...ctx.state.issues]
      : [...ctx.state.tickets.filter((t) => t.phase === phaseId), ...ctx.state.issues.filter((i) => i.phase === phaseId)];
  const decisions = decisionsSection(ctx.root, items, mode);
  if (mode !== "all") {
    if (ctx.format === "json") return { output: withSectionJson(output, "decisions", decisions.json) };
    return { output: `${output}\n\n${decisions.md.join("\n")}` };
  }

  const capabilities = capabilitySection(ctx.root);
  const glossary = glossarySection(ctx.root);
  if (ctx.format === "json") {
    return {
      output: withSectionJson(
        withSectionJson(withSectionJson(output, "capabilities", capabilities.json), "glossary", glossary.json),
        "decisions",
        decisions.json,
      ),
    };
  }
  return { output: `${output}\n\n${capabilities.md.join("\n")}\n\n${glossary.md.join("\n")}\n\n${decisions.md.join("\n")}` };
}
