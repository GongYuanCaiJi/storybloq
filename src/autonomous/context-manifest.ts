/**
 * T-526 (P-3): the context manifest. What a plan was written and reviewed
 * AGAINST, recorded so the workflow can tell "which decision revision the plan
 * saw" from "which decision is current now".
 *
 * Publication writes an immutable pair per generation under
 * `<session>/context-manifests/`: `<item>-<generation>.md` (the rendered brief)
 * then `<item>-<generation>.json` (the manifest), then `context-brief.md`, then
 * the state pointer. A pair is trusted only when `sha256(md) === briefHash`.
 *
 * The gate (`governingChangeGate`) diffs the pointer's authoritative pair
 * against the ledger now. A change to a GOVERNING ruling becomes an obligation
 * the next plan must address; an id that can no longer be resolved, or a pair
 * that fails integrity, puts the item into recovery, and recovery never clears
 * on its own say-so: only a later gate that finds everything resolvable, or an
 * explicit `brief --rebase`, clears it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, withProjectLock } from "../core/project-loader.js";
import type { ProjectState } from "../core/project-state.js";
import { loadRulingsSafe, loadUpwardBoard } from "../core/ruling-loader.js";
import { buildCitationResolutionContext, resolveCitation, type CitationResolutionContext } from "../core/ruling.js";
import { payloadDigest } from "../core/ruling-lifecycle.js";
import { boardContext, buildContextBrief, type BriefManifestDraft, type BuildBriefOptions, type ContextBrief } from "./context-brief.js";
import type { FullSessionState } from "./session-types.js";
import { readSession, sessionDir as sessionDirFor, withSessionLock, writeSessionSync } from "./session.js";

export const MANIFEST_DIR = "context-manifests";
export const CONTEXT_BRIEF_FILE = "context-brief.md";

// --- shapes ---

export interface ContextManifest extends BriefManifestDraft {
  readonly version: 1;
  readonly generation: number;
  readonly provisional: boolean;
  readonly renderedAt: string;
}

export type ObligationKind = "revised" | "newly-accepted" | "superseded" | "withdrawn";

export interface Obligation {
  readonly id: string;
  readonly kind: ObligationKind;
  readonly from: string;
  readonly to: string;
  readonly raisedAt: string;
  readonly generation: number;
}

export interface ContextPointer {
  /** `<item>-<generation>` of the authoritative pair. */
  readonly current: string;
  readonly generation: number;
  /**
   * Copied from the authoritative manifest in the same state write as
   * `current`, so recovery never depends on that file being readable. Absent
   * only on an entry written before the field existed.
   */
  readonly governingIds?: readonly string[];
  readonly outstanding: readonly Obligation[];
  readonly recovery: null | { readonly reasons: readonly string[]; readonly raisedAt: string };
  readonly rebased?: { readonly by: string; readonly reason: string; readonly at: string; readonly from: string };
  readonly planApprovalInvalidated: null | { readonly minGeneration: number; readonly token: string };
  /** The invalidation token read when the current plan review round started. */
  readonly reviewToken?: string | null;
  /** The `contextManifest` reference that round's packet carried. */
  readonly reviewRef?: string | null;
}

export type ContextManifests = Readonly<Record<string, ContextPointer>>;

const FamilyStateSchema = z.union([
  z.object({ state: z.literal("ok") }),
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("unreadable"), errorClass: z.string() }),
  z.object({ state: z.literal("check-incomplete"), count: z.number() }),
]);

const ManifestSchema = z.object({
  version: z.literal(1),
  item: z.string(),
  generation: z.number().int().min(1),
  provisional: z.boolean(),
  renderedAt: z.string(),
  briefHash: z.string().regex(/^[0-9a-f]{64}$/),
  families: z.object({ rulings: FamilyStateSchema, capabilities: FamilyStateSchema, glossary: FamilyStateSchema }),
  rulingsUnverifiable: z.array(z.string()),
  rulings: z.array(
    z.object({
      id: z.string(),
      tier: z.enum(["binding", "suggested", "proposed"]),
      payloadDigest: z.string().nullable(),
      lifecycle: z.string().nullable(),
      delivered: z.boolean(),
      reasons: z.array(z.string()).optional(),
    }),
  ),
  capabilities: z.array(
    z.object({
      id: z.string(),
      checkedAtSha: z.string(),
      effectiveStatus: z.enum(["current", "review"]),
      semanticDigest: z.string(),
      pendingNote: z.string().nullable(),
      delivered: z.boolean(),
    }),
  ),
  stale: z.array(z.object({ id: z.string(), reasons: z.array(z.string()) })),
  terms: z.array(z.object({ id: z.string(), semanticDigest: z.string(), pendingNote: z.string().nullable(), delivered: z.boolean() })),
});

const ObligationSchema = z.object({
  id: z.string(),
  kind: z.enum(["revised", "newly-accepted", "superseded", "withdrawn"]),
  from: z.string(),
  to: z.string(),
  raisedAt: z.string(),
  generation: z.number().int(),
});

const PointerSchema = z.object({
  current: z.string().min(1),
  generation: z.number().int().min(1),
  governingIds: z.array(z.string()).optional(),
  outstanding: z.array(ObligationSchema),
  recovery: z.object({ reasons: z.array(z.string()), raisedAt: z.string() }).nullable(),
  rebased: z.object({ by: z.string(), reason: z.string(), at: z.string(), from: z.string() }).optional(),
  planApprovalInvalidated: z.object({ minGeneration: z.number().int(), token: z.string() }).nullable(),
  reviewToken: z.string().nullable().optional(),
  reviewRef: z.string().nullable().optional(),
});

const PointersSchema = z.record(PointerSchema);

/**
 * The strict reader for `state.contextManifests`, declared `z.unknown()` on the
 * session so one damaged value cannot make the session unreadable. A value
 * that fails here is `unreadable`, never "no manifests": absence would let a
 * plan proceed with no gate at all.
 */
export function readContextManifests(raw: unknown): { ok: true; map: ContextManifests } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, map: {} };
  const parsed = PointersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `state.contextManifests is malformed (${parsed.error.issues[0]?.code ?? "invalid"})` };
  return { ok: true, map: parsed.data as ContextManifests };
}

export function manifestName(item: string, generation: number): string {
  return `${item}-${generation}`;
}

/** The reference a review packet carries. */
export function manifestRef(name: string): string {
  return `${MANIFEST_DIR}/${name}`;
}

/** Governing = every ruling id the manifest delivered or could not verify. */
export function governingIds(m: Pick<ContextManifest, "rulings" | "rulingsUnverifiable">): string[] {
  // An entry the cap or the budget kept out of the brief never reached the
  // plan, so a change to it obliges the plan to nothing.
  return [...new Set([...m.rulings.filter((r) => r.delivered).map((r) => r.id), ...m.rulingsUnverifiable])];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// --- publication ---

export class ManifestPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestPublishError";
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highest generation with ANY file on disk for the item: a half-written pair still claims its number. */
export function latestGeneration(sessionDir: string, item: string): number {
  const dir = join(sessionDir, MANIFEST_DIR);
  if (!existsSync(dir)) return 0;
  const re = new RegExp(`^${escapeRegex(item)}-(\\d+)\\.(md|json)$`);
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface PublishOptions {
  readonly generation: number;
  readonly provisional: boolean;
  readonly now?: () => Date;
  /** Test seam: the writer, so a failure after each step can be injected. */
  readonly write?: (path: string, content: string) => Promise<void>;
}

/**
 * Writes the pair and the brief file. Never overwrites a published pair: a
 * generation is immutable once any of its files exists.
 */
export async function publishContextManifest(
  sessionDir: string,
  brief: ContextBrief,
  opts: PublishOptions,
): Promise<{ name: string; manifest: ContextManifest }> {
  const write = opts.write ?? atomicWrite;
  const name = manifestName(brief.item.id, opts.generation);
  const dir = join(sessionDir, MANIFEST_DIR);
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${name}.md`);
  const json = join(dir, `${name}.json`);
  if (existsSync(md) || existsSync(json)) throw new ManifestPublishError(`manifest ${name} already exists; a published generation is immutable`);
  const suggestedReasons = new Map(brief.suggested.map((s) => [s.id, s.reasons]));
  const manifest: ContextManifest = {
    version: 1,
    ...brief.manifest,
    rulings: brief.manifest.rulings.map((r) =>
      r.tier === "suggested" ? { ...r, reasons: [...(suggestedReasons.get(r.id) ?? [])] } : r,
    ),
    generation: opts.generation,
    provisional: opts.provisional,
    renderedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  await write(md, brief.rendered);
  await write(json, `${JSON.stringify(manifest, null, 2)}\n`);
  await write(join(sessionDir, CONTEXT_BRIEF_FILE), brief.rendered);
  return { name, manifest };
}

export type PairRead = { ok: true; manifest: ContextManifest; md: string } | { ok: false; reason: string };

/** Reads one pair and verifies it: the json parses, names itself, and hashes its md. */
export function readManifestPair(sessionDir: string, name: string): PairRead {
  const dir = join(sessionDir, MANIFEST_DIR);
  let md: string;
  let raw: string;
  try {
    md = readFileSync(join(dir, `${name}.md`), "utf-8");
    raw = readFileSync(join(dir, `${name}.json`), "utf-8");
  } catch {
    return { ok: false, reason: `manifest ${name} is missing or unreadable` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `manifest ${name} is not valid JSON` };
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `manifest ${name} does not match the manifest schema` };
  const manifest = parsed.data as ContextManifest;
  if (manifestName(manifest.item, manifest.generation) !== name) return { ok: false, reason: `manifest ${name} names a different item or generation` };
  if (sha256(md) !== manifest.briefHash) return { ok: false, reason: `manifest ${name} failed integrity: its brief does not match the recorded hash` };
  return { ok: true, manifest, md };
}

// --- diff ---

export interface ManifestDiff {
  readonly integrity: boolean;
  readonly integrityReason: string | null;
  readonly governing: readonly Omit<Obligation, "raisedAt" | "generation">[];
  readonly unverifiable: readonly string[];
  readonly incidental: { readonly capabilities: readonly string[]; readonly terms: readonly string[] };
}

/** This board's rulings plus, for a linked node, its orchestrator's (T-520), as the brief resolves them. */
function ledgerContext(root: string): CitationResolutionContext {
  const scan = loadRulingsSafe(root);
  const local = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries);
  const upward = loadUpwardBoard(root);
  return upward ? { ...local, upward } : local;
}

function short(digest: string | null): string {
  return digest === null ? "unknown" : `digest ${digest.slice(0, 12)}`;
}

/**
 * The authoritative pair against the ledger now. Governing: a ruling the item
 * cites, one in the authoritative governing set (or the persisted copy when
 * the pair cannot be read), or one newly accepted that the item's keys or a
 * matched capability now reach. Everything else is incidental and invalidates
 * nothing.
 */
export async function diffContextManifest(
  root: string,
  sessionDir: string,
  pointer: ContextPointer,
  itemRef: string,
  opts: Pick<BuildBriefOptions, "state" | "checkOptions"> & { brief?: ContextBrief } = {},
): Promise<ManifestDiff> {
  const pair = readManifestPair(sessionDir, pointer.current);
  const prev = pair.ok ? pair.manifest : null;
  const prevGoverning = prev !== null ? governingIds(prev) : [...(pointer.governingIds ?? [])];
  const ctx = ledgerContext(root);
  const now = opts.brief ?? (await buildContextBrief(root, itemRef, opts));
  const ids = [...new Set([...prevGoverning, ...now.item.citesRulings, ...pointer.outstanding.map((o) => o.id)])];

  const governing: Omit<Obligation, "raisedAt" | "generation">[] = [];
  const unverifiable: string[] = [];
  for (const id of ids) {
    const before = prev?.rulings.find((r) => r.id === id) ?? null;
    const res = resolveCitation(id, ctx);
    if (res.status === "resolved") {
      if (res.current.id !== id) {
        // A successor the authoritative pair already governed is a transition
        // the plan already had; raising it again would loop the item through
        // PLAN on every diff. A change to the successor itself is caught under
        // its own id, which is in the governing set.
        const incorporated = prev !== null
          ? prev.rulings.some((r) => r.id === res.current.id && r.delivered)
          : prevGoverning.includes(res.current.id);
        if (!incorporated) governing.push({ id, kind: "superseded", from: id, to: res.current.id });
        continue;
      }
      const ruling = boardContext(ctx, res.board).rulingsById.get(id);
      const digest = ruling ? payloadDigest(ruling) : null;
      if (before?.tier === "proposed") {
        governing.push({ id, kind: "newly-accepted", from: "proposed", to: "accepted" });
      } else if (before !== null && before.payloadDigest !== null && digest !== null && before.payloadDigest !== digest) {
        governing.push({ id, kind: "revised", from: short(before.payloadDigest), to: short(digest) });
      }
      continue;
    }
    if (res.status === "nonaccepted") {
      if (res.lifecycle === "withdrawn") {
        governing.push({ id, kind: "withdrawn", from: before?.lifecycle ?? "accepted", to: "withdrawn" });
        continue;
      }
      // A proposal still pending is what it was: nothing changed.
      if (res.lifecycle === "proposed" && before?.tier === "proposed") continue;
    }
    // Cited-but-unresolvable ids the plan-pin guard already refuses; only a
    // previously governing or outstanding id makes the item unverifiable.
    if (prevGoverning.includes(id) || pointer.outstanding.some((o) => o.id === id)) unverifiable.push(id);
  }
  if (prev !== null) {
    for (const s of now.suggested) {
      if (!now.delivered.suggested.includes(s.id)) continue;
      if (!prev.rulings.some((r) => r.id === s.id && r.delivered) && !governing.some((g) => g.id === s.id)) {
        governing.push({ id: s.id, kind: "newly-accepted", from: "absent", to: "accepted" });
      }
    }
  }
  const capabilities = prev === null ? [] : now.manifest.capabilities
    .filter((c) => {
      const b = prev.capabilities.find((x) => x.id === c.id);
      return b === undefined || b.semanticDigest !== c.semanticDigest || b.pendingNote !== c.pendingNote;
    })
    .map((c) => c.id);
  const terms = prev === null ? [] : now.manifest.terms
    .filter((t) => {
      const b = prev.terms.find((x) => x.id === t.id);
      return b === undefined || b.semanticDigest !== t.semanticDigest || b.pendingNote !== t.pendingNote;
    })
    .map((t) => t.id);
  return {
    integrity: pair.ok,
    integrityReason: pair.ok ? null : pair.reason,
    governing,
    unverifiable,
    incidental: { capabilities, terms },
  };
}

/**
 * Folds a diff into the pointer. Obligations accumulate (deduplicated by id and
 * target) and are never cleared here. Recovery is set by a failed integrity or
 * any unverifiable id, and cleared only when this diff found the pair intact
 * and nothing unverifiable, which covers every governing and outstanding id.
 */
export function applyDiff(pointer: ContextPointer, diff: ManifestDiff, at: string): ContextPointer {
  const outstanding = [...pointer.outstanding];
  for (const g of diff.governing) {
    if (!outstanding.some((o) => o.id === g.id && o.to === g.to)) {
      outstanding.push({ ...g, raisedAt: at, generation: pointer.generation });
    }
  }
  const reasons: string[] = [];
  if (!diff.integrity) reasons.push(diff.integrityReason ?? "manifest failed integrity");
  if (diff.unverifiable.length > 0) reasons.push(`governing ruling(s) could not be resolved: ${diff.unverifiable.join(", ")}`);
  const recovery = reasons.length > 0 ? { reasons, raisedAt: pointer.recovery?.raisedAt ?? at } : null;
  return { ...pointer, outstanding, recovery };
}

export function obligationLines(pointer: ContextPointer | null): string[] {
  if (pointer === null) return [];
  const lines = pointer.outstanding.map(
    (o) => `governing context changed: ${o.id} ${o.kind} ${o.from} to ${o.to}; assess impact before continuing`,
  );
  if (pointer.recovery !== null) {
    lines.push(`recovery required: ${pointer.recovery.reasons.join("; ")}; repair the ledger or run \`storybloq brief --rebase <sessionId> <item> --reason "<why>"\``);
  }
  return lines;
}

/** Ids a plan must name before an approval can clear the item's obligations. */
export function mustAddress(pointer: ContextPointer | null): string[] {
  return pointer === null ? [] : [...new Set(pointer.outstanding.map((o) => o.id))];
}

/** True when CODE_REVIEW may not start on this item's current plan. */
export function blocksCodeReview(pointer: ContextPointer | null): boolean {
  return pointer !== null && (pointer.outstanding.length > 0 || pointer.recovery !== null || pointer.planApprovalInvalidated !== null);
}

// --- guide integration ---

export interface GateResult {
  readonly map: ContextManifests;
  readonly pointer: ContextPointer | null;
  /** Set when the stored map could not be read; the caller must not treat that as "no manifests". */
  readonly unreadable: string | null;
  readonly changed: boolean;
}

function withPointer(map: ContextManifests, item: string, pointer: ContextPointer): ContextManifests {
  return { ...map, [item]: pointer };
}

/** The gate on resume, replan, drift and CODE_REVIEW entry. Pure apart from reading the ledger. */
export async function governingChangeGate(
  root: string,
  sessionDir: string,
  state: Pick<FullSessionState, "contextManifests">,
  item: string,
  opts: Pick<BuildBriefOptions, "state" | "checkOptions"> & { now?: () => Date; brief?: ContextBrief } = {},
): Promise<GateResult> {
  const read = readContextManifests((state as { contextManifests?: unknown }).contextManifests);
  if (!read.ok) return { map: {}, pointer: null, unreadable: read.reason, changed: false };
  const pointer = read.map[item] ?? null;
  if (pointer === null) return { map: read.map, pointer: null, unreadable: null, changed: false };
  const diff = await diffContextManifest(root, sessionDir, pointer, item, opts);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const next = applyDiff(pointer, diff, at);
  const changed = JSON.stringify(next) !== JSON.stringify(pointer);
  return { map: withPointer(read.map, item, next), pointer: next, unreadable: null, changed };
}

export interface EnterPlanContext {
  /** Lines to prepend to the PLAN instruction: obligations, recovery, and publication failures. */
  readonly preamble: readonly string[];
  /** Null when the stored map could not be read: the caller must leave the damaged value in place. */
  readonly contextManifests: ContextManifests | null;
  readonly pointer: ContextPointer | null;
  readonly brief: ContextBrief | null;
}

/**
 * `enterPlan`'s context half: gate, publish the next generation, move the
 * pointer (unless recovery holds it on the authoritative pair), and return the
 * lines the instruction opens with. The caller persists `contextManifests` in
 * its own state write and builds the instruction.
 */
export async function prepareContextForPlan(
  root: string,
  sessionDir: string,
  state: Pick<FullSessionState, "contextManifests">,
  item: string,
  opts: Pick<BuildBriefOptions, "state" | "checkOptions"> & { now?: () => Date; write?: PublishOptions["write"] } = {},
): Promise<EnterPlanContext> {
  const now = opts.now ?? (() => new Date());
  const preamble: string[] = [];
  let brief: ContextBrief | null = null;
  try {
    brief = await buildContextBrief(root, item, opts);
  } catch (err) {
    preamble.push(`context brief could not be built (${(err as Error).message}); plan from the item and its cited rulings, and say so in the plan`);
  }
  const gate = await governingChangeGate(root, sessionDir, state, item, { ...opts, ...(brief !== null && { brief }) });
  if (gate.unreadable !== null) {
    return {
      preamble: [`recovery required: ${gate.unreadable}; the context manifest state cannot be trusted, so the governing context of this plan is unknown`, ...preamble],
      contextManifests: null,
      pointer: null,
      brief,
    };
  }
  let pointer = gate.pointer;
  try {
    if (brief === null) throw new Error("no brief to publish");
    const generation = Math.max(latestGeneration(sessionDir, brief.item.id), pointer?.generation ?? 0) + 1;
    const provisional = pointer?.recovery != null;
    const published = await publishContextManifest(sessionDir, brief, { generation, provisional, now, ...(opts.write && { write: opts.write }) });
    if (!provisional) {
      pointer = {
        current: published.name,
        generation,
        governingIds: governingIds(published.manifest),
        outstanding: pointer?.outstanding ?? [],
        recovery: null,
        ...(pointer?.rebased && { rebased: pointer.rebased }),
        planApprovalInvalidated: pointer?.planApprovalInvalidated ?? null,
        reviewToken: null,
      };
    }
  } catch (err) {
    preamble.push(`context brief could not be published (${(err as Error).message}); plan from the item and its cited rulings, and say so in the plan`);
  }
  preamble.unshift(...obligationLines(pointer));
  const map = pointer === null ? gate.map : withPointer(gate.map, brief?.item.id ?? item, pointer);
  return { preamble, contextManifests: map, pointer, brief };
}

/**
 * At a PLAN_REVIEW approve. Obligations clear when the reviewed packet named
 * the current pair and recovery is clear (the plan-pin guard already refused
 * any plan that did not name every outstanding id). The invalidation from a
 * rebase clears only when, in addition, the approved generation is at least
 * the rebased one, nothing is outstanding, and the token read when this review
 * started is still the stored token.
 */
export function clearOnApproval(pointer: ContextPointer, reviewedRef: string | null): ContextPointer {
  if (reviewedRef !== manifestRef(pointer.current) || pointer.recovery !== null) return pointer;
  const inv = pointer.planApprovalInvalidated;
  const invalidationClears =
    inv !== null && pointer.generation >= inv.minGeneration && pointer.reviewToken != null && pointer.reviewToken === inv.token;
  return {
    ...pointer,
    outstanding: [],
    planApprovalInvalidated: invalidationClears ? null : inv,
  };
}

/**
 * Called when a plan review round starts: remembers the invalidation token it
 * started under and the manifest reference its packet carried, so the
 * approval that ends the round is judged against what the reviewer saw.
 */
export function markReviewStart(pointer: ContextPointer, packetRef: string): ContextPointer {
  return { ...pointer, reviewToken: pointer.planApprovalInvalidated?.token ?? null, reviewRef: packetRef };
}

/**
 * The reference a plan review packet carries: the authoritative pair, or the
 * newer provisional pair the plan was written against while recovery is set.
 */
export function packetManifestRef(sessionDir: string, item: string, pointer: ContextPointer): { ref: string; provisional: boolean } {
  if (pointer.recovery !== null) {
    const latest = latestGeneration(sessionDir, item);
    if (latest > pointer.generation) return { ref: manifestRef(manifestName(item, latest)), provisional: true };
  }
  return { ref: manifestRef(pointer.current), provisional: false };
}

/** Suggested ids and reasons from the authoritative pair, for the review packet. Empty when the pair is unreadable. */
export function suggestedFromCurrent(sessionDir: string, pointer: ContextPointer): { id: string; reasons: string[] }[] {
  const read = readManifestPair(sessionDir, pointer.current);
  if (!read.ok) return [];
  return read.manifest.rulings
    .filter((r) => r.tier === "suggested" && r.delivered)
    .map((r) => ({ id: r.id, reasons: [...((r as { reasons?: readonly string[] }).reasons ?? [])] }));
}

export function currentItemId(state: Pick<FullSessionState, "ticket" | "currentIssue">): string | null {
  return state.ticket?.id ?? (state.currentIssue as { id?: string } | undefined)?.id ?? null;
}

// --- rebase ---

export class RebaseRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebaseRefusal";
  }
}

function latestProvisionalPair(sessionDir: string, item: string, above: number): { name: string; read: PairRead } | null {
  for (let g = latestGeneration(sessionDir, item); g > above; g -= 1) {
    const name = manifestName(item, g);
    const read = readManifestPair(sessionDir, name);
    if (!read.ok) return { name, read };
    if (read.manifest.provisional) return { name, read };
  }
  return null;
}

/**
 * `brief --rebase`: adopt the latest provisional pair as authoritative after a
 * recovery the ledger alone could not clear. Under the session lock, then the
 * project lock (the guide's order). Refused unless that pair is intact and every id the old
 * authoritative set, the new set and the outstanding obligations name can be
 * resolved now. Success invalidates the approved plan: a fresh approval under
 * the new token is required before CODE_REVIEW.
 */
export async function rebaseContextManifest(
  root: string,
  sessionId: string,
  itemRef: string,
  reason: string,
  by: string,
  now: () => Date = () => new Date(),
): Promise<ContextPointer> {
  if (reason.trim() === "") throw new RebaseRefusal("--reason is required: say why the provisional context is being adopted");
  let result: ContextPointer | null = null;
  // Session lock first, then the project lock: the guide's order, so a rebase
  // and a guide call that writes the ledger can never each hold what the
  // other waits for.
  await withSessionLock(root, async () => {
    await withProjectLock(root, { strict: false }, async ({ state: project }: { state: ProjectState }) => {
      const dir = sessionDirFor(root, sessionId);
      const session = readSession(dir);
      if (session === null) throw new RebaseRefusal(`session ${sessionId} could not be read`);
      const ticket = project.resolveTicketRef(itemRef);
      const issue = ticket.kind === "found" ? null : project.resolveIssueRef(itemRef);
      const item = ticket.kind === "found" ? ticket.item.id : issue?.kind === "found" ? issue.item.id : null;
      if (item === null) throw new RebaseRefusal(`${itemRef} could not be resolved to a ticket or issue`);
      const read = readContextManifests((session as { contextManifests?: unknown }).contextManifests);
      if (!read.ok) throw new RebaseRefusal(read.reason);
      const pointer = read.map[item];
      if (!pointer) throw new RebaseRefusal(`no context manifest is recorded for ${item} in session ${sessionId}`);
      if (pointer.governingIds === undefined) throw new RebaseRefusal("governing set unknown; repair the manifest file");
      const latest = latestProvisionalPair(dir, item, pointer.generation);
      if (latest === null) throw new RebaseRefusal(`no provisional manifest newer than ${pointer.current} to rebase onto`);
      if (!latest.read.ok) throw new RebaseRefusal(`the latest provisional manifest cannot be adopted: ${latest.read.reason}`);
      const provisional = latest.read.manifest;
      const ctx = ledgerContext(root);
      const ids = [...new Set([...pointer.governingIds, ...governingIds(provisional), ...pointer.outstanding.map((o) => o.id)])];
      const unavailable = ids.filter((id) => {
        const res = resolveCitation(id, ctx);
        if (res.status === "resolved") return false;
        return !(res.status === "nonaccepted" && (res.lifecycle === "proposed" || res.lifecycle === "withdrawn"));
      });
      if (unavailable.length > 0) throw new RebaseRefusal(`rebase refused: these governing rulings cannot be resolved now: ${unavailable.join(", ")}`);
      const next: ContextPointer = {
        ...pointer,
        current: latest.name,
        generation: provisional.generation,
        governingIds: governingIds(provisional),
        recovery: null,
        rebased: { by, reason, at: now().toISOString(), from: pointer.current },
        planApprovalInvalidated: { minGeneration: provisional.generation, token: randomUUID() },
      };
      writeSessionSync(dir, { ...session, contextManifests: withPointer(read.map, item, next) } as FullSessionState);
      result = next;
    });
  });
  return result!;
}
