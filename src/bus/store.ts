import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadProject } from "../core/project-loader.js";
import { displayIdOf } from "../core/resolver.js";
import type { ProjectState } from "../core/project-state.js";
import { assertBusEnabled, isBusEnabled } from "./config.js";
import { canonicalHash, hashWithoutKey } from "./canonical.js";
import { listEndpoints, withEndpointCaller } from "./endpoints.js";
import { BusError } from "./errors.js";
import { ensureDerivedThread, foldBusThread, writeDerivedThread } from "./fold.js";
import {
  BusReceiptSchema,
  readReceipt,
  removeReceipt,
  writeReceipt,
  type BusReceipt,
} from "./idempotency.js";
import {
  durableCreate,
  durableRename,
  durableUnlink,
  durableWrite,
  listRegularJsonFiles,
  readJsonNoFollow,
  syncDirectory,
} from "./io.js";
import { withHardenedLock } from "./lock.js";
import { readBusHookPolicy } from "./hooks.js";
import {
  assessBusRuntime,
  assessBusRuntimeAtPaths,
  classifyBusRuntime,
  readBusInstance,
  resolveInitializedBusPaths,
  runtimeLostError,
  type BusRuntimeAssessment,
} from "./admin.js";
import { readBusEvidence } from "./runtime-evidence.js";
import { ackV1, doctorV1, exportV1Thread, summarizeV1 } from "./legacy-v1.js";
import {
  assertBusLayout,
  busLayoutFindings,
  endpointMailboxPath,
  resolveBusPaths,
  type BusPaths,
} from "./paths.js";
import {
  BUS_MAX_ENTRY_BYTES,
  BusEndpointSchema,
  BusEntrySchema,
  BusEvidenceRefSchema,
  BusMailboxCounterSchema,
  BusMailboxPointerSchema,
  BusMessageKindSchema,
  BusMessageRefsSchema,
  BusSeveritySchema,
  BusSuccessionSchema,
  BusThreadKindSchema,
  BusThreadRecordSchema,
  derivedRole,
  type BusAckPayload,
  type BusClient,
  type BusDeliveryCapabilities,
  type BusDeliveryMode,
  type BusEndpoint,
  type BusEntry,
  type BusEvidenceRef,
  type BusMailboxPointer,
  type BusMessageKind,
  type BusMessagePayload,
  type BusMessageRefs,
  type BusParticipantSummary,
  type BusRole,
  type BusSetupState,
  type BusSeverity,
  type BusStatePayload,
  type BusSummary,
  type BusThreadKind,
  type BusThreadRecord,
  type FoldedBusThread,
} from "./schemas.js";
import {
  actionableFingerprint,
  assertNoHighConfidenceSecret,
  evidenceKeys,
  idempotencyKeyHash,
  normalizeBusText,
  normalizeMessageBody,
  normalizeMessageRefs,
} from "./security.js";

const ThreadIdSchema = z.string().uuid();
const EndpointIdSchema = z.string().uuid();
const MessageIdSchema = z.string().uuid();
const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;

// Test-only seam: fires inside mailboxHasPointerCandidate AFTER a directory's initial
// lstat succeeds and BEFORE its readdir, so a test can delete/swap the directory mid-scan
// and prove the probe escalates (throws) rather than reporting a false "empty".
let afterMailboxLstatHook: ((dir: string) => Promise<void>) | null = null;
let materializeFailureHook: (() => Promise<void>) | null = null;
let countFailureHook: (() => Promise<void>) | null = null;
const RECEIPT_FILENAME = /^([a-f0-9]{64})\.json$/;
const ACTIONABLE_KINDS = new Set<BusMessageKind>(["issue_notice", "question", "reply", "patch_request"]);

export interface BusSendInput {
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly threadId?: string;
  readonly threadKind?: BusThreadKind;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs?: BusMessageRefs;
  readonly inReplyTo?: string | null;
  readonly idempotencyKey: string;
  readonly predecessorThreadId?: string;
}

export interface BusSendResult {
  readonly threadId: string;
  readonly messageId: string | null;
  readonly toEndpoint: string;
  readonly state: "open" | "parked" | "resolved";
  readonly hopCount: number;
  readonly replayed: boolean;
  readonly parked: boolean;
}

export interface BusPollEnvelope {
  readonly source: "storybloq_bus";
  readonly authority: "peer_agent";
  readonly integrity: "verified" | "quarantined";
  readonly sender: { readonly endpointId: string; readonly client: BusClient; readonly role: BusRole | null };
  readonly threadId: string;
  readonly mailboxSeq: number;
  readonly message: BusMessagePayload;
}

export interface BusPollResult {
  readonly endpointId: string;
  readonly cursor: number;
  readonly messages: readonly BusPollEnvelope[];
  readonly findings: readonly string[];
}

interface NormalizedSend {
  readonly toEndpointId: string;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs: BusMessageRefs;
  readonly inReplyTo: string | null;
  readonly keyHash: string;
  readonly payloadHash: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function padSeq(seq: number, width = 6): string {
  return String(seq).padStart(width, "0");
}

function entryFilename(entry: BusEntry): string {
  return `${padSeq(entry.seq)}-${entry.type}-${entry.entryId}.json`;
}

function pointerFilename(pointer: BusMailboxPointer): string {
  return `${padSeq(pointer.mailboxSeq, 12)}-${pointer.messageId}.json`;
}

function participantsInclude(thread: BusThreadRecord, endpointId: string): boolean {
  return thread.participants[0] === endpointId || thread.participants[1] === endpointId;
}

// ISS-872: a successor's bounded predecessor-chain walk is capped so a corrupt
// on-disk record can never make the read seams loop or trust an unbounded lineage.
// Unreachable in practice: every hop requires a proven-offline replace.
const MAX_SUCCESSION_DEPTH = 64;

// ISS-872: the set of recipient ids whose mail this endpoint may read/ack/administer
// -- its own id plus its bounded predecessor CHAIN (the endpoint it replaced, that
// endpoint's predecessor, ...). Authority propagates transitively across repeated
// replacement (B->S->T) so a second replacement does not re-strand the original
// recipient's mail (T must inherit B, not just S). A successor LEAVING without a
// replacement is out of scope here (the deferred all-participants-retired case, ISS-873).
// Pure over the already-loaded endpoint list (no I/O); every caller already has the
// list. Security-sensitive:
// a corrupt chain (cycle, missing ancestor, or over-depth) must NEVER grant
// authority, so it fails CLOSED to self-only and reports `corrupt` for the caller
// (doctor) to surface. Used ONLY by the read/ack/administer seams, never send/reply.
function endpointAddressees(
  endpoint: BusEndpoint,
  allEndpoints: readonly BusEndpoint[],
): { ids: string[]; corrupt: string | null } {
  const byId = new Map(allEndpoints.map((candidate) => [candidate.endpointId, candidate]));
  const ids: string[] = [endpoint.endpointId];
  const visited = new Set<string>([endpoint.endpointId]);
  let current: BusEndpoint = endpoint;
  let depth = 0;
  while (current.predecessorEndpointId) {
    const predecessorId = current.predecessorEndpointId;
    if (visited.has(predecessorId)) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain cycles at ${predecessorId}` };
    }
    if (++depth > MAX_SUCCESSION_DEPTH) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain exceeds max depth ${MAX_SUCCESSION_DEPTH}` };
    }
    const ancestor = byId.get(predecessorId);
    // A retired ancestor keeps its record (retire only sets retiredAt), so a MISSING
    // ancestor means a deleted/tampered endpoint file -- corruption, not a normal end
    // of chain. Fail closed rather than silently truncate the inherited authority.
    if (!ancestor) {
      return { ids: [endpoint.endpointId], corrupt: `predecessor chain references missing ancestor ${predecessorId}` };
    }
    // A legitimate predecessor was retired specifically BY replacement (joinEndpoint
    // stamps retiredReason "replaced"). A link to an ACTIVE endpoint, or to one retired
    // by `leave` or forced retirement, is NOT a real succession and must never grant
    // authority over that endpoint's mail/threads -- fail closed to self-only. This is a
    // security boundary: UUID existence alone cannot establish inherited authority.
    if (!ancestor.retiredAt || ancestor.retiredReason !== "replaced") {
      return { ids: [endpoint.endpointId], corrupt: `predecessor ${predecessorId} was not retired by replacement` };
    }
    visited.add(predecessorId);
    ids.push(predecessorId);
    current = ancestor;
  }
  return { ids, corrupt: null };
}

// ISS-872: a pointer is canonically valid iff its thread folds verified and the entry
// it names is a message whose hash, id, and recipient match the pointer (and the
// recipient is one this endpoint may receive). Mirrors pollBus's delivery validation.
// The succession sweep uses this so a corrupt pointer (valid envelope, wrong canonical
// binding) never authorizes deleting an ancestor's only valid pointer, and a
// canonically mismatched ancestor pointer is preserved as corruption evidence.
function pointerMatchesCanonical(
  folded: FoldedBusThread | null,
  pointer: BusMailboxPointer,
  addressees: readonly string[],
): boolean {
  if (!folded || folded.integrity !== "verified") return false;
  const entry = folded.entries[pointer.entrySeq - 1];
  return !!entry && entry.type === "message" && entry.entryHash === pointer.entryHash &&
    entry.payload.messageId === pointer.messageId && addressees.includes(entry.payload.to);
}

function makeEntry<T extends BusEntry["type"]>(input: {
  type: T;
  threadId: string;
  seq: number;
  prevHash: string;
  payload: Extract<BusEntry, { type: T }>["payload"];
}): Extract<BusEntry, { type: T }> {
  const unsigned = {
    schema: "storybloq-bus-entry/v2" as const,
    entryId: randomUUID(),
    threadId: input.threadId,
    seq: input.seq,
    type: input.type,
    prevHash: input.prevHash,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    entryHash: "0".repeat(64),
  };
  const signed = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
  return BusEntrySchema.parse(signed) as Extract<BusEntry, { type: T }>;
}

async function listThreadIds(paths: BusPaths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.threads, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BusError("io_error", "Cannot enumerate Bus threads", err);
  }
  // A dot-prefixed name is not excluded here as a special case: the ThreadIdSchema
  // filter below already drops any name that is not a valid UUID (including a
  // dot-prefixed one). A dot-renamed thread directory is surfaced as an "invalid
  // thread directory" finding by the doctor's separate threads enumeration.
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => ThreadIdSchema.safeParse(name).success)
    .sort();
}

// Highest mailbox seq the recipient endpoint has already surfaced (blocked on either
// channel) or polled. Durable evidence used as a RECOVERY floor when reallocating a
// mailbox seq after counter.json is lost while the mailbox is empty: without it, neither
// the absent counter nor the empty pointer scan remembers already-delivered sequences,
// so a reallocated seq could land at or below lastPolled/lastBlocked and be suppressed
// forever by both hook gates. A missing endpoint record yields 0 (no evidence, no floor);
// the counter and pointer floors still apply. A corrupt/symlinked record fails closed.
async function endpointCursorFloor(paths: BusPaths, endpointId: string): Promise<number> {
  try {
    const endpoint = await readJsonNoFollow(join(paths.endpoints, `${endpointId}.json`), BusEndpointSchema);
    return Math.max(
      endpoint.lastPolledMailboxSeq,
      endpoint.lastBlockedMailboxSeq,
      endpoint.lastToolBlockedMailboxSeq ?? 0,
    );
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return 0;
    throw err;
  }
}

async function allocateMailboxSeq(paths: BusPaths, endpointId: string): Promise<number> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  return withHardenedLock(join(paths.locks, `mailbox-${endpointId}.lock`), async () => {
    const counterPath = join(mailbox, "counter.json");
    let nextSeq = 1;
    try {
      nextSeq = (await readJsonNoFollow(counterPath, BusMailboxCounterSchema)).nextSeq;
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
    let pointerFloor = 1;
    for (const directory of [mailbox, join(mailbox, "pending")]) {
      for (const filename of await listRegularJsonFiles(directory)) {
        const match = POINTER_FILENAME.exec(filename);
        if (match) pointerFloor = Math.max(pointerFloor, Number(match[1]) + 1);
      }
    }
    // Fold in the endpoint's delivered-cursor floor so a lost counter (empty mailbox)
    // cannot regress the sequence below what the recipient already saw.
    const cursorFloor = await endpointCursorFloor(paths, endpointId);
    nextSeq = Math.max(nextSeq, pointerFloor, cursorFloor + 1);
    await durableWrite(counterPath, serialize({
      schema: "storybloq-bus-mailbox-counter/v1",
      nextSeq: nextSeq + 1,
      updatedAt: new Date().toISOString(),
    }));
    return nextSeq;
  });
}

function makePointer(endpointId: string, mailboxSeq: number, entry: Extract<BusEntry, { type: "message" }>): BusMailboxPointer {
  return BusMailboxPointerSchema.parse({
    schema: "storybloq-bus-mailbox/v2",
    endpointId,
    mailboxSeq,
    messageId: entry.payload.messageId,
    threadId: entry.threadId,
    entrySeq: entry.seq,
    entryHash: entry.entryHash,
    createdAt: entry.createdAt,
  });
}

async function publishPointerIntent(paths: BusPaths, pointer: BusMailboxPointer): Promise<{ pending: string; active: string }> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const active = join(mailbox, filename);
  await durableCreate(pending, serialize(pointer));
  return { pending, active };
}

async function activatePointer(intent: { pending: string; active: string }): Promise<void> {
  try {
    await durableRename(intent.pending, intent.active);
  } catch {
    // The immutable pending intent is sufficient for poll recovery.
  }
}

function normalizeRefsAgainstProject(state: ProjectState, refs: BusMessageRefs): BusMessageRefs {
  const normalized = normalizeMessageRefs(refs);
  if (normalized.issue) {
    const resolved = state.resolveIssueRef(normalized.issue);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Issue reference not found or ambiguous: ${normalized.issue}`);
    normalized.issue = resolved.item.id;
  }
  if (normalized.ticket) {
    const resolved = state.resolveTicketRef(normalized.ticket);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Ticket reference not found or ambiguous: ${normalized.ticket}`);
    normalized.ticket = resolved.item.id;
  }
  return normalized;
}

function validateIssueNotice(state: ProjectState, kind: BusMessageKind, severity: BusSeverity, refs: BusMessageRefs): void {
  if (kind !== "issue_notice") return;
  if (!refs.issue) throw new BusError("invalid_input", "An issue notice requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue) throw new BusError("invalid_input", `Issue does not exist: ${refs.issue}`);
  if (issue.status === "resolved") throw new BusError("invalid_input", `${displayIdOf(issue)} is already resolved`);
  if (issue.severity !== severity) {
    throw new BusError("invalid_input", `Issue notice severity must match ${displayIdOf(issue)} (${issue.severity})`);
  }
}

function validateCriticalReference(
  state: ProjectState,
  severity: BusSeverity,
  refs: BusMessageRefs,
  required: boolean,
): void {
  if (severity !== "critical" || !required) return;
  if (!refs.issue) throw new BusError("invalid_input", "A critical Bus message requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue || issue.status === "resolved" || issue.severity !== "critical") {
    throw new BusError("invalid_input", "A critical Bus message requires an unresolved critical issue");
  }
}

function normalizeSend(
  state: ProjectState,
  maxBodyBytes: number,
  requireIssueForCritical: boolean,
  endpoint: BusEndpoint,
  toEndpointId: string,
  input: BusSendInput,
): NormalizedSend {
  const messageKind = BusMessageKindSchema.parse(input.messageKind);
  const severity = BusSeveritySchema.parse(input.severity);
  const body = normalizeMessageBody(input.body, maxBodyBytes);
  const refs = normalizeRefsAgainstProject(state, BusMessageRefsSchema.parse(input.refs ?? {}));
  validateIssueNotice(state, messageKind, severity, refs);
  validateCriticalReference(state, severity, refs, requireIssueForCritical);
  const inReplyTo = input.inReplyTo ?? null;
  if (inReplyTo && !MessageIdSchema.safeParse(inReplyTo).success) throw new BusError("invalid_input", "Invalid reply message id");
  const keyHash = idempotencyKeyHash(endpoint.endpointId, input.idempotencyKey);
  // payloadHash binds the resolved operation, including the recipient (D3), so a
  // reused key after the peer was replaced recomputes a different hash and fails
  // idempotency_conflict instead of silently replaying to the retired endpoint.
  const payloadHash = canonicalHash({
    fromEndpoint: endpoint.endpointId,
    toEndpoint: toEndpointId,
    kind: messageKind,
    severity,
    body,
    refs,
    inReplyTo,
    threadKind: input.threadKind ?? null,
    targetThreadId: input.threadId ?? null,
    predecessorThreadId: input.predecessorThreadId ?? null,
  });
  return { toEndpointId, messageKind, severity, body, refs, inReplyTo, keyHash, payloadHash };
}

function topicRefFrom(refs: BusMessageRefs): Record<string, string> {
  const topic = {
    ...(refs.issue ? { issue: refs.issue } : {}),
    ...(refs.ticket ? { ticket: refs.ticket } : {}),
    ...(refs.commit ? { commit: refs.commit } : {}),
    ...(refs.ciRun ? { ciRun: refs.ciRun } : {}),
  };
  if (Object.keys(topic).length === 0) {
    throw new BusError("invalid_input", "A new thread requires an issue, ticket, commit, or CI run reference");
  }
  return topic;
}

function validateInitialKinds(threadKind: BusThreadKind, messageKind: BusMessageKind): void {
  const valid = threadKind === "coordination"
    ? ["status", "claim", "release"].includes(messageKind)
    : threadKind === messageKind;
  if (!valid) throw new BusError("invalid_input", `Initial ${messageKind} message does not match ${threadKind} thread`);
}

function replayFromFold(folded: FoldedBusThread, receipt: BusReceipt): BusSendResult {
  return {
    threadId: receipt.threadId,
    messageId: receipt.messageId ?? null,
    toEndpoint: receipt.toEndpoint,
    state: folded.state,
    hopCount: folded.hopCount,
    replayed: true,
    // `parked` reports whether THIS operation was an automatic park, taken solely
    // from the receipt outcome. The thread's current state (which a later park could
    // flip) is conveyed separately by `state`, so replaying a delivered message after
    // the thread was later parked still returns parked:false with its real messageId.
    parked: receipt.outcome === "parked",
  };
}

// Resolves the sole active (non-retired) peer for the caller. Self-send is
// structurally impossible: the caller is never returned as its own peer.
async function resolveActivePeer(paths: BusPaths, selfEndpointId: string): Promise<BusEndpoint | null> {
  const { endpoints, findings } = await listEndpoints(paths.projectRoot);
  if (findings.length > 0) {
    throw new BusError("corrupt", `Endpoint registry is corrupt: ${findings[0]}`);
  }
  const peers = endpoints.filter((endpoint) => !endpoint.retiredAt && endpoint.endpointId !== selfEndpointId);
  if (peers.length === 0) return null;
  if (peers.length > 1) {
    throw new BusError("conflict", "Two-endpoint invariant violated: multiple active peers");
  }
  return peers[0] ?? null;
}

async function readThreadParticipants(paths: BusPaths, threadId: string): Promise<[string, string]> {
  const thread = await readJsonNoFollow(join(paths.threads, threadId, "thread.json"), BusThreadRecordSchema);
  if (thread.threadId !== threadId) throw new BusError("corrupt", "Thread id does not match its directory");
  return thread.participants as [string, string];
}

function messagePayload(
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  messageId: string,
): BusMessagePayload {
  return {
    messageId,
    from: {
      endpointId: endpoint.endpointId,
      client: endpoint.client,
      authority: "peer_agent",
    },
    to: toEndpointId,
    kind: normalized.messageKind,
    severity: normalized.severity,
    body: normalized.body,
    refs: normalized.refs,
    inReplyTo: normalized.inReplyTo,
    idempotencyKeyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
  };
}

function pendingReceiptFor(
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  publication: { threadId: string; messageId: string; mailboxSeq: number },
): BusReceipt {
  return BusReceiptSchema.parse({
    schema: "storybloq-bus-receipt/v1",
    endpointId: endpoint.endpointId,
    keyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
    threadId: publication.threadId,
    toEndpoint: normalized.toEndpointId,
    messageId: publication.messageId,
    mailboxSeq: publication.mailboxSeq,
    state: "pending",
    createdAt: new Date().toISOString(),
  });
}

// An automatic park has no message and no mailbox pointer, so the receipt carries
// no messageId/mailboxSeq (permitted by the schema only when outcome is "parked").
// It is bound to the park state entry by `stateEntryHash`: the pending form is
// written BEFORE the park entry and finalized after, and recovery locates that
// exact entry in the chain regardless of the thread's later state (D3/#4/#R6-A).
function parkedReceiptFor(
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  threadId: string,
  toEndpointId: string,
  state: "pending" | "final",
  stateEntryHash: string,
): BusReceipt {
  return BusReceiptSchema.parse({
    schema: "storybloq-bus-receipt/v1",
    endpointId: endpoint.endpointId,
    keyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
    threadId,
    toEndpoint: toEndpointId,
    state,
    outcome: "parked",
    stateEntryHash,
    createdAt: new Date().toISOString(),
  });
}

async function createThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  input: BusSendInput,
  maxHops: number,
): Promise<BusSendResult> {
  const threadKind = BusThreadKindSchema.parse(input.threadKind);
  validateInitialKinds(threadKind, normalized.messageKind);
  if (input.predecessorThreadId && !ThreadIdSchema.safeParse(input.predecessorThreadId).success) {
    throw new BusError("invalid_input", "Invalid predecessor thread id");
  }
  return withHardenedLock(join(paths.locks, "threads.lock"), async () => {
    if (input.predecessorThreadId) {
      const predecessor = await foldBusThread(paths.projectRoot, input.predecessorThreadId);
      if (predecessor.integrity !== "verified" || predecessor.state !== "resolved") {
        throw new BusError("conflict", "A predecessor thread must be integrity-verified and resolved");
      }
      if (!participantsInclude(predecessor.thread, endpoint.endpointId) ||
          !participantsInclude(predecessor.thread, toEndpointId)) {
        throw new BusError("unauthorized", "A successor must retain the predecessor participants");
      }
    }

    const threadId = randomUUID();
    const messageId = randomUUID();
    const message = messagePayload(endpoint, toEndpointId, normalized, messageId);
    const unsignedThread = {
      schema: "storybloq-bus-thread/v2" as const,
      threadId,
      kind: threadKind,
      topicRef: topicRefFrom(normalized.refs),
      participants: [endpoint.endpointId, toEndpointId] as [string, string],
      maxHops,
      createdByEndpoint: endpoint.endpointId,
      createdAt: new Date().toISOString(),
      ...(input.predecessorThreadId ? { predecessorThreadId: input.predecessorThreadId } : {}),
      threadHash: "0".repeat(64),
    };
    const thread: BusThreadRecord = {
      ...unsignedThread,
      threadHash: hashWithoutKey(unsignedThread, "threadHash"),
    };
    const entry = makeEntry({ type: "message", threadId, seq: 1, prevHash: thread.threadHash, payload: message });
    if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
      throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
    }
    const mailboxSeq = await allocateMailboxSeq(paths, toEndpointId);
    // The pending receipt carries full publication identity BEFORE any entry
    // exists, so recovery can address the exact pointer without a mailbox scan.
    await writeReceipt(paths, pendingReceiptFor(endpoint, normalized, { threadId, messageId, mailboxSeq }));
    const pointer = makePointer(toEndpointId, mailboxSeq, entry);
    const intent = await publishPointerIntent(paths, pointer);
    const tempDir = join(paths.threads, `.tmp-${threadId}-${randomUUID()}`);
    const finalDir = join(paths.threads, threadId);
    try {
      await mkdir(join(tempDir, "entries"), { recursive: true, mode: 0o700 });
      await durableCreate(join(tempDir, "thread.json"), serialize(thread));
      await durableCreate(join(tempDir, "entries", entryFilename(entry)), serialize(entry));
      await syncDirectory(join(tempDir, "entries"));
      await syncDirectory(tempDir);
      await durableRename(tempDir, finalDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    await activatePointer(intent);
    const folded = await foldBusThread(paths.projectRoot, threadId);
    await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
    await finalizeReceipt(paths, endpoint.endpointId, normalized.keyHash, {
      payloadHash: normalized.payloadHash,
      threadId,
      toEndpoint: toEndpointId,
      messageId,
      mailboxSeq,
    });
    return { threadId, messageId: message.messageId, toEndpoint: toEndpointId, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: false };
  });
}

// Exported for direct unit testing of the delivered-finalization identity guard
// (the already-final ordering + the parked/endpointId/keyHash rejections), which
// is otherwise a defense-in-depth branch not reachable in a single locked scope.
export async function finalizeReceipt(
  paths: BusPaths,
  endpointId: string,
  keyHash: string,
  expected: { payloadHash: string; threadId: string; toEndpoint: string; messageId: string; mailboxSeq: number },
): Promise<void> {
  const current = await readReceipt(paths, endpointId, keyHash);
  if (!current) {
    // The pending receipt was published earlier in this same endpoint-locked
    // scope; its absence means external corruption. Fail closed rather than
    // reporting success without a durable final receipt (which would let a
    // retry republish a duplicate).
    throw new BusError("corrupt", "Cannot finalize idempotency receipt; the pending receipt is missing");
  }
  // Verify identity BEFORE honoring an already-final receipt, so a mismatched
  // or externally corrupted receipt is never silently accepted. This is the
  // DELIVERED finalization path only: a receipt bearing `outcome: "parked"`
  // (which the schema lets omit messageId/mailboxSeq) must never be finalized
  // for a published message, or a retry would treat it as a terminal park and
  // skip indexed-message verification. The internal endpointId/keyHash are also
  // checked against the path arguments so a misfiled receipt cannot be honored.
  if (
    current.outcome === "parked" ||
    current.endpointId !== endpointId ||
    current.keyHash !== keyHash ||
    current.payloadHash !== expected.payloadHash ||
    current.threadId !== expected.threadId ||
    current.toEndpoint !== expected.toEndpoint ||
    current.messageId !== expected.messageId ||
    current.mailboxSeq !== expected.mailboxSeq
  ) {
    throw new BusError("corrupt", "The pending receipt does not match the published operation");
  }
  if (current.state === "final") return;
  await writeReceipt(paths, { ...current, state: "final" });
}

function duplicateActionable(folded: FoldedBusThread, fromEndpointId: string, toEndpointId: string, normalized: NormalizedSend): boolean {
  if (!ACTIONABLE_KINDS.has(normalized.messageKind)) return false;
  const candidate = actionableFingerprint({
    fromEndpointId,
    toEndpointId,
    kind: normalized.messageKind,
    body: normalized.body,
    refs: normalized.refs,
  });
  return folded.messages.some((message) =>
    ACTIONABLE_KINDS.has(message.kind) &&
    actionableFingerprint({
      fromEndpointId: message.from.endpointId,
      toEndpointId: message.to,
      kind: message.kind,
      body: message.body,
      refs: message.refs,
    }) === candidate,
  );
}

async function appendStateEntry(
  paths: BusPaths,
  folded: FoldedBusThread,
  payload: BusStatePayload,
): Promise<FoldedBusThread> {
  const entry = makeEntry({
    type: "state",
    threadId: folded.thread.threadId,
    seq: folded.validThroughSeq + 1,
    prevHash: folded.lastHash,
    payload,
  });
  await durableCreate(join(paths.threads, folded.thread.threadId, "entries", entryFilename(entry)), serialize(entry));
  const next = await foldBusThread(paths.projectRoot, folded.thread.threadId);
  await writeDerivedThread(paths.projectRoot, next).catch(() => undefined);
  return next;
}

async function replyToThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  threadId: string,
): Promise<BusSendResult> {
  if (!ThreadIdSchema.safeParse(threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
  return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    if (folded.state !== "open") throw new BusError("thread_parked", `Thread is ${folded.state}`);
    if (!participantsInclude(folded.thread, endpoint.endpointId) || !participantsInclude(folded.thread, toEndpointId)) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    if (normalized.inReplyTo && !folded.messages.some((message) => message.messageId === normalized.inReplyTo)) {
      throw new BusError("invalid_input", "Reply target does not exist in this thread");
    }

    const overHopCap = ACTIONABLE_KINDS.has(normalized.messageKind) && folded.hopCount >= folded.thread.maxHops;
    const duplicate = duplicateActionable(folded, endpoint.endpointId, toEndpointId, normalized);
    if (overHopCap || duplicate) {
      // Crash-safe park (D3/#4/#R6-A): PREALLOCATE the park state entry so the
      // pending receipt can bind to its exact identity (`entryHash`) BEFORE the
      // entry lands. Write the pending parked receipt, durably create that exact
      // entry, then finalize the receipt. Recovery locates the entry by its hash
      // in the folded chain regardless of the thread's current state, so a later
      // resolve/reopen cannot lose the committed parked outcome and an unrelated
      // park cannot be misattributed to this receipt.
      const parkEntry = makeEntry({
        type: "state",
        threadId,
        seq: folded.validThroughSeq + 1,
        prevHash: folded.lastHash,
        payload: {
          action: "park",
          byEndpoint: endpoint.endpointId,
          reason: overHopCap ? `Maximum hop count ${folded.thread.maxHops} reached` : "Duplicate actionable fingerprint",
          automatic: true,
          trigger: overHopCap ? "hop_cap" : "duplicate_fingerprint",
          // Bind this automatic park to the exact idempotent send that triggered it.
          // committedAutomaticPark requires both to equal the replaying receipt's
          // keyHash/payloadHash, so a tampered receipt whose stateEntryHash names a
          // DIFFERENT same-endpoint automatic park is rejected, not misattributed.
          idempotencyKeyHash: normalized.keyHash,
          payloadHash: normalized.payloadHash,
        },
      });
      await writeReceipt(paths, parkedReceiptFor(endpoint, normalized, threadId, toEndpointId, "pending", parkEntry.entryHash));
      await durableCreate(join(paths.threads, threadId, "entries", entryFilename(parkEntry)), serialize(parkEntry));
      folded = await foldBusThread(paths.projectRoot, threadId);
      await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      await writeReceipt(paths, parkedReceiptFor(endpoint, normalized, threadId, toEndpointId, "final", parkEntry.entryHash));
      return { threadId, messageId: null, toEndpoint: toEndpointId, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: true };
    }

    const messageId = randomUUID();
    const message = messagePayload(endpoint, toEndpointId, normalized, messageId);
    const entry = makeEntry({
      type: "message",
      threadId,
      seq: folded.validThroughSeq + 1,
      prevHash: folded.lastHash,
      payload: message,
    });
    if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
      throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
    }
    const mailboxSeq = await allocateMailboxSeq(paths, toEndpointId);
    await writeReceipt(paths, pendingReceiptFor(endpoint, normalized, { threadId, messageId, mailboxSeq }));
    const intent = await publishPointerIntent(paths, makePointer(toEndpointId, mailboxSeq, entry));
    await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
    await activatePointer(intent);
    folded = await foldBusThread(paths.projectRoot, threadId);
    await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
    await finalizeReceipt(paths, endpoint.endpointId, normalized.keyHash, {
      payloadHash: normalized.payloadHash,
      threadId,
      toEndpoint: toEndpointId,
      messageId,
      mailboxSeq,
    });
    return { threadId, messageId: message.messageId, toEndpoint: toEndpointId, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: false };
  });
}

// True only when the pointer file at `path` parses and canonically equals the
// reconstructed pointer. Absent, truncated, or unreadable all return false, so
// the caller (re)creates it from the authoritative thread entry; any real IO
// error then surfaces from the subsequent durableCreate, never here.
async function pointerFileDelivered(path: string, expectedBytes: string): Promise<boolean> {
  try {
    const pointer = await readJsonNoFollow(path, BusMailboxPointerSchema);
    return serialize(pointer) === expectedBytes;
  } catch {
    return false;
  }
}

// Read a mailbox pointer without following symlinks, returning null ONLY when the
// path is provably absent. A present-but-corrupt/symlinked/unreadable pointer
// propagates its BusError (corrupt/io_error) so the caller fails closed rather than
// treating an unverifiable file as "nothing here".
async function readPointerOrNull(path: string): Promise<BusMailboxPointer | null> {
  try {
    return await readJsonNoFollow(path, BusMailboxPointerSchema);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return null;
    throw err;
  }
}

// Recover a crashed prior attempt (D3 rule 2). Returns a replay result when the
// message is durably present, or null when it is provably absent (so the caller
// proceeds with a fresh publication). Fails closed on any fold/IO error.
// A parked receipt is bound to the exact AUTOMATIC park state entry it committed
// (parkedReceiptFor sets stateEntryHash to that entry's entryHash). Recovery and
// replay match by entryHash AND park semantics: a corrupted or misfiled receipt
// whose stateEntryHash happens to name a resolve, reopen, or manual park entry must
// not be replayed as this operation's automatic parked outcome. entryHash is a
// content hash (unique per entry), so a match is exact identity; this layers the
// semantic guard on top. The park entry ALSO carries the triggering send's
// idempotencyKeyHash/payloadHash (both covered by entryHash), and the match requires
// them to equal the replaying receipt's keyHash/payloadHash: a tampered or misfiled
// receipt whose stateEntryHash names a DIFFERENT same-endpoint automatic park is
// rejected rather than misattributed, since that other park binds a different send.
// Returns the entry when present with matching automatic-park semantics AND operation
// binding; null when NO entry carries that hash (the park never committed); throws
// `corrupt` when an entry with that hash exists but is not this endpoint's automatic
// park for this exact send. The schema requires stateEntryHash on parked receipts, so
// a missing hash is external corruption and also fails closed here.
function committedAutomaticPark(
  folded: FoldedBusThread,
  receipt: BusReceipt,
): Extract<BusEntry, { type: "state" }> | null {
  if (receipt.stateEntryHash == null) {
    throw new BusError("corrupt", "A parked receipt must carry the hash of the park entry it commits");
  }
  const match = folded.entries.find((candidate) => candidate.entryHash === receipt.stateEntryHash);
  if (!match) return null;
  if (
    match.type !== "state" ||
    match.payload.action !== "park" ||
    match.payload.automatic !== true ||
    match.payload.trigger == null ||
    match.payload.byEndpoint !== receipt.endpointId ||
    match.payload.idempotencyKeyHash !== receipt.keyHash ||
    match.payload.payloadHash !== receipt.payloadHash
  ) {
    throw new BusError("corrupt", "The recorded park entry is not this endpoint's automatic park");
  }
  return match;
}

async function recoverPendingReceipt(
  paths: BusPaths,
  endpoint: BusEndpoint,
  receipt: BusReceipt,
  expectedPayloadHash: string,
): Promise<BusSendResult | null> {
  let folded: FoldedBusThread | null = null;
  try {
    folded = await foldBusThread(paths.projectRoot, receipt.threadId);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      folded = null; // thread never landed; the message is provably absent
    } else {
      throw err instanceof BusError ? err : new BusError("io_error", "Cannot recover pending receipt", err);
    }
  }
  if (folded && folded.integrity !== "verified") {
    throw new BusError("corrupt", "Cannot recover idempotency; the recorded thread is quarantined");
  }
  // Pending parked receipt (D3/#4/#R6-A): an automatic park crashed between its
  // pending receipt and its finalization. The receipt is bound to the park state
  // entry by `stateEntryHash`, so we prove the park committed by locating THAT
  // exact entry (identity + automatic-park semantics) in the folded chain, NOT by
  // the thread's current state: a later resolve/reopen must still replay the
  // committed park, and an unrelated or non-automatic park must not be misattributed
  // here. Present -> finalize and replay parked; absent -> the park never committed,
  // so remove the receipt and retry; wrong semantics -> committedAutomaticPark throws.
  if (receipt.outcome === "parked") {
    const parked = folded != null ? committedAutomaticPark(folded, receipt) : null;
    if (parked) {
      if (receipt.payloadHash !== expectedPayloadHash) {
        throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
      }
      await writeReceipt(paths, { ...receipt, state: "final" });
      return replayFromFold(folded!, { ...receipt, state: "final" });
    }
    await removeReceipt(paths, endpoint.endpointId, receipt.keyHash);
    return null;
  }
  const entry = folded && receipt.messageId
    ? folded.entries.find((candidate) => candidate.type === "message" && candidate.payload.messageId === receipt.messageId)
    : undefined;
  if (folded && entry && entry.type === "message") {
    // A reused idempotency key that resolves to a different payload is a conflict,
    // detected BEFORE any mailbox mutation. The recorded in-flight message stays
    // recoverable on a retry with its original payload (#3).
    if (receipt.payloadHash !== expectedPayloadHash) {
      throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
    }
    // Verify the located entry actually matches the recorded receipt before any
    // mailbox mutation. A stale or externally corrupted receipt must never
    // finalize a different message as delivered.
    if (
      entry.threadId !== receipt.threadId ||
      entry.payload.from.endpointId !== endpoint.endpointId ||
      entry.payload.to !== receipt.toEndpoint ||
      entry.payload.idempotencyKeyHash !== receipt.keyHash ||
      entry.payload.payloadHash !== receipt.payloadHash
    ) {
      throw new BusError("corrupt", "The recovered message does not match the pending receipt");
    }
    // Ensure the recipient pointer reaches its active destination, validating
    // contents (not just the pathname) and re-verifying after activation. Run
    // under the recipient reconcile lock so a concurrent poll cannot race the
    // recreate/activate.
    const pointer = makePointer(receipt.toEndpoint, receipt.mailboxSeq ?? entry.seq, entry);
    const mailbox = endpointMailboxPath(paths, receipt.toEndpoint);
    const filename = pointerFilename(pointer);
    const active = join(mailbox, filename);
    const pending = join(mailbox, "pending", filename);
    const expectedBytes = serialize(pointer);
    await withHardenedLock(join(paths.locks, `mailbox-reconcile-${receipt.toEndpoint}.lock`), async () => {
      if (await pointerFileDelivered(active, expectedBytes)) return;
      if (!(await pointerFileDelivered(pending, expectedBytes))) {
        // The pending pointer is absent OR present-but-invalid (truncated /
        // envelope-corrupt). durableCreate is exclusive (it links onto the
        // target), so it would throw `conflict` on an existing invalid file.
        // Durably remove any such file first, then recreate it from the
        // authoritative entry. durableUnlink no-ops on ENOENT and propagates
        // any real IO error, so a failed removal is never silently ignored.
        await durableUnlink(pending);
        await durableCreate(pending, expectedBytes);
      }
      await activatePointer({ pending, active });
      if (!(await pointerFileDelivered(active, expectedBytes))) {
        throw new BusError("io_error", "Could not durably deliver the recovered mailbox pointer");
      }
    });
    await finalizeReceipt(paths, endpoint.endpointId, receipt.keyHash, {
      payloadHash: receipt.payloadHash,
      threadId: receipt.threadId,
      toEndpoint: receipt.toEndpoint,
      messageId: entry.payload.messageId,
      mailboxSeq: receipt.mailboxSeq ?? entry.seq,
    });
    return replayFromFold(folded, { ...receipt, state: "final" });
  }
  // Message provably absent: the only pointer this crashed attempt could have left is
  // its OWN pending intent. Remove it ONLY when the on-disk pointer envelope proves it
  // belongs to THIS receipt (endpointId/mailboxSeq/messageId/threadId all match). A
  // schema-valid but externally corrupted receipt for this key could otherwise name an
  // UNRELATED delivery's pointer, and a blind unlink would delete that live message. A
  // foreign pending pointer, or ANY active pointer at the recorded path (activation
  // follows the entry durableCreate, so an absent message cannot have a live pointer),
  // is anomalous: fail closed and leave it intact, never blind-unlink another delivery.
  if (receipt.messageId && receipt.mailboxSeq) {
    const mailbox = endpointMailboxPath(paths, receipt.toEndpoint);
    const filename = `${padSeq(receipt.mailboxSeq, 12)}-${receipt.messageId}.json`;
    const ownsPointer = (pointer: BusMailboxPointer): boolean =>
      pointer.endpointId === receipt.toEndpoint &&
      pointer.mailboxSeq === receipt.mailboxSeq &&
      pointer.messageId === receipt.messageId &&
      pointer.threadId === receipt.threadId;
    const pendingPointer = await readPointerOrNull(join(mailbox, "pending", filename));
    if (pendingPointer) {
      if (!ownsPointer(pendingPointer)) {
        throw new BusError("corrupt", "The pending mailbox pointer at the recorded path does not belong to this receipt");
      }
      await durableUnlink(join(mailbox, "pending", filename));
    }
    if (await readPointerOrNull(join(mailbox, filename))) {
      throw new BusError("corrupt", "An active mailbox pointer occupies the recorded path for a message with no committed entry");
    }
  }
  await removeReceipt(paths, endpoint.endpointId, receipt.keyHash);
  return null;
}

export async function sendBusMessage(root: string, input: BusSendInput): Promise<BusSendResult> {
  if (!EndpointIdSchema.safeParse(input.endpointId).success) throw new BusError("invalid_input", "Invalid endpoint id");
  if (input.threadId && (input.threadKind || input.predecessorThreadId)) {
    throw new BusError("invalid_input", "Replies cannot set threadKind or predecessorThreadId");
  }
  if (!input.threadId && !input.threadKind) {
    throw new BusError("invalid_input", "A new Bus thread requires threadKind");
  }
  const loaded = await loadProject(root);
  const config = assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    // Resolve the recipient. For a reply, the recipient is the thread's other
    // participant (which fails closed if retired); for a new thread it is the
    // sole active peer.
    let toEndpointId: string;
    // A reply into a thread whose peer has retired is only refused for a genuinely
    // NEW publication. A reply's recipient is the thread's fixed participant, so the
    // keyHash/payloadHash are stable regardless of the peer's liveness; a committed
    // reply must therefore still replay/recover after the peer retires (idempotent
    // replay cannot depend on current peer liveness, or a crash + retry after the
    // peer's task ends would be permanently unreplayable). Defer the throw until
    // after the receipt-replay path below.
    let replyPeerRetired = false;
    // A new-thread send resolves its recipient from the sole active peer. If that
    // peer has retired, a COMMITTED send must still replay its receipt (idempotent
    // replay must not depend on current peer liveness -- the same principle as the
    // reply path), so defer the no_peer refusal past the receipt-replay block.
    let newThreadNoPeer = false;
    if (input.threadId) {
      if (!ThreadIdSchema.safeParse(input.threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
      const participants = await readThreadParticipants(paths, input.threadId);
      if (!participants.includes(endpoint.endpointId)) {
        throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
      }
      toEndpointId = participants[0] === endpoint.endpointId ? participants[1] : participants[0];
      const { endpoints, findings } = await listEndpoints(paths.projectRoot);
      if (findings.length > 0) {
        throw new BusError("corrupt", `Endpoint registry is corrupt: ${findings[0]}`);
      }
      const other = endpoints.find((candidate) => candidate.endpointId === toEndpointId);
      replyPeerRetired = !other || !!other.retiredAt;
    } else {
      const peer = await resolveActivePeer(paths, endpoint.endpointId);
      if (peer) {
        toEndpointId = peer.endpointId;
      } else {
        // No active peer. The idempotency key (and thus the receipt path) does NOT
        // depend on the recipient, so read the prior receipt directly: a committed
        // send replays against its recorded toEndpoint even after the peer retires.
        // A genuinely fresh send (no prior receipt) still fails closed with no_peer,
        // deferred to after the replay path so a committed send is never masked.
        const priorKeyHash = idempotencyKeyHash(endpoint.endpointId, input.idempotencyKey);
        const prior = await readReceipt(paths, endpoint.endpointId, priorKeyHash);
        if (!prior) {
          throw new BusError("no_peer", "The Bus has no active peer endpoint (waiting_for_peer). Run `storybloq bus setup` in the other task.");
        }
        toEndpointId = prior.toEndpoint;
        newThreadNoPeer = true;
      }
    }

    const normalized = normalizeSend(
      loaded.state,
      config.maxBodyBytes,
      config.requireIssueForCritical,
      endpoint,
      toEndpointId,
      input,
    );

    // Durable idempotency index (D3): O(1) replay, no full-runtime fold.
    const receipt = await readReceipt(paths, endpoint.endpointId, normalized.keyHash);
    if (receipt) {
      // The receipt is loaded by (endpointId, keyHash) PATH, so a receipt whose
      // INTERNAL endpointId/keyHash disagrees with the path is misfiled or
      // corrupted. Reject before either the final-replay or recovery branch, since
      // a final parked receipt skips entry verification entirely and a delivered
      // replay never re-checks endpointId; a misfiled receipt must never replay.
      if (receipt.endpointId !== endpoint.endpointId || receipt.keyHash !== normalized.keyHash) {
        throw new BusError("corrupt", "The recorded receipt does not match the requesting endpoint or key");
      }
      if (receipt.state === "final") {
        if (receipt.payloadHash !== normalized.payloadHash) {
          throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
        }
        const folded = await foldBusThread(paths.projectRoot, receipt.threadId);
        if (folded.integrity !== "verified") {
          throw new BusError("corrupt", "Cannot replay; the recorded thread is quarantined");
        }
        // A delivered receipt must still index its message entry before we replay;
        // a parked receipt must still index its bound automatic-park state entry (by
        // stateEntryHash AND park semantics), so a final parked receipt is verified
        // against the chain exactly like the pending recovery path rather than trusted
        // blindly. A final parked receipt whose park entry is absent or carries wrong
        // semantics is corruption (the park was finalized, so the entry must exist).
        if (receipt.outcome !== "parked") {
          const indexed = receipt.messageId
            ? folded.entries.find((candidate) => candidate.type === "message" && candidate.payload.messageId === receipt.messageId)
            : undefined;
          if (
            !indexed || indexed.type !== "message" ||
            indexed.threadId !== receipt.threadId ||
            indexed.payload.from.endpointId !== endpoint.endpointId ||
            indexed.payload.to !== receipt.toEndpoint ||
            indexed.payload.idempotencyKeyHash !== receipt.keyHash ||
            indexed.payload.payloadHash !== receipt.payloadHash
          ) {
            throw new BusError("corrupt", "Cannot replay; the recorded message is missing or does not match its receipt");
          }
        } else if (committedAutomaticPark(folded, receipt) == null) {
          throw new BusError("corrupt", "Cannot replay; the recorded park entry is missing or does not match its receipt");
        }
        return replayFromFold(folded, receipt);
      }
      // Recovery detects an idempotency_conflict (reused key, different payload)
      // before any mailbox mutation and returns a replay only when the payload
      // matches; a null return means the crashed attempt never committed and was
      // superseded, so we continue with a fresh send.
      const recovered = await recoverPendingReceipt(paths, endpoint, receipt, normalized.payloadHash);
      if (recovered) return recovered;
    }

    // No committed operation to replay: this is a fresh publication. A fresh reply
    // into a thread whose peer has retired is refused here (the deferred check above),
    // AFTER the replay path so a committed reply still replays post-retirement.
    if (input.threadId && replyPeerRetired) {
      throw new BusError("participant_retired", "The thread's peer participant is retired; resolve the thread");
    }
    // A committed new-thread send already replayed above. Reaching here with
    // newThreadNoPeer means the prior receipt was pending-but-never-committed
    // (recovery returned null), so refuse rather than createThread to a retired peer.
    if (!input.threadId && newThreadNoPeer) {
      throw new BusError("no_peer", "The Bus has no active peer endpoint (waiting_for_peer). Run `storybloq bus setup` in the other task.");
    }

    return input.threadId
      ? replyToThread(paths, endpoint, toEndpointId, normalized, input.threadId)
      : createThread(paths, endpoint, toEndpointId, normalized, input, config.maxHops);
  });
}

async function mailboxPointers(paths: BusPaths, endpointId: string): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  const pointers: BusMailboxPointer[] = [];
  const findings: string[] = [];
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    for (const filename of await listRegularJsonFiles(directory)) {
      // A dot-prefixed `.json` entry is unexpected where only pointers (and
      // counter.json) belong: durable-write temp files are never dot-prefixed, so a
      // pointer renamed `<pointer>.json` -> `.<pointer>.json` would otherwise be
      // silently dropped by the POINTER_FILENAME skip and hidden from delivery.
      if (filename.startsWith(".")) {
        findings.push(`${filename}: unexpected dot-prefixed entry`);
        continue;
      }
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(directory, filename), BusMailboxPointerSchema);
        if (pointer.endpointId !== endpointId || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its endpoint or filename");
        }
        pointers.push(pointer);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const unique = new Map<string, BusMailboxPointer>();
  for (const pointer of pointers) unique.set(pointer.messageId, pointer);
  return { pointers: [...unique.values()].sort((a, b) => a.mailboxSeq - b.mailboxSeq), findings };
}

// T-427 cheap tool-hook gate. Lock-free, fold-free discriminated high-water read:
// counter.json's `nextSeq` is the NEXT seq to hand out, so the highest seq already
// allocated to this mailbox is `nextSeq - 1`. A mailbox that never allocated has no
// counter.json (readJsonNoFollow -> BusError "not_found") -> `known: false`. Any
// OTHER failure (corrupt/symlinked/unreadable counter) propagates so an unreadable
// counter is never silently treated as "unknown". Lock-free is sound: a concurrent
// allocateMailboxSeq only ever RAISES nextSeq, so a torn read under-reports by at
// most one and never over-reports, and the tool gate treats "unknown" as "escalate".
export type MailboxHighwater =
  | { readonly known: true; readonly highwater: number }
  | { readonly known: false };

export async function readMailboxHighwater(paths: BusPaths, endpointId: string): Promise<MailboxHighwater> {
  const counterPath = join(endpointMailboxPath(paths, endpointId), "counter.json");
  try {
    const counter = await readJsonNoFollow(counterPath, BusMailboxCounterSchema);
    return { known: true, highwater: counter.nextSeq - 1 };
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return { known: false };
    throw err;
  }
}

// T-427 hot-path seed. A never-messaged endpoint has no counter.json, so its PostToolUse
// gate would fall to the mailboxHasPointerCandidate directory scan on EVERY tool call
// (readMailboxHighwater returns `known:false` until the first send allocates a seq).
// After the gate confirms the mailbox is present-and-empty AND the endpoint has no
// surfaced history (all delivery cursors zero -- the caller's precondition), it seeds
// counter.json with `nextSeq:1`, so subsequent tool calls take the single-read
// known-highwater fast path (highwater 0, not newer -> skip) instead of re-scanning.
//
// The seed runs under the SAME per-mailbox lock allocateMailboxSeq uses and re-reads the
// counter while holding it, seeding only if still absent. This serializes with a racing
// first send: durableCreate exposes the final pathname before its write completes, so
// seeding OUTSIDE the lock could hand a concurrent allocateMailboxSeq a partially-written
// counter (a transient corrupt read). Under the lock, either the send already allocated
// (counter present -> skip) or it has not (counter absent -> we write nextSeq:1, which is
// exactly the send's own starting floor). One-time per never-messaged endpoint.
export async function seedMailboxCounterIfAbsent(paths: BusPaths, endpointId: string): Promise<void> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  const counterPath = join(mailbox, "counter.json");
  await withHardenedLock(join(paths.locks, `mailbox-${endpointId}.lock`), async () => {
    try {
      await readJsonNoFollow(counterPath, BusMailboxCounterSchema);
      return; // already allocated/seeded by a racing send -> nothing to do
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
    await durableCreate(counterPath, serialize({
      schema: "storybloq-bus-mailbox-counter/v1",
      nextSeq: 1,
      updatedAt: new Date().toISOString(),
    }));
  });
}

// T-427 fold-free existence probe used by the rendezvous long-poll interval tick:
// does the endpoint's mailbox hold ANY pointer-shaped file (active or pending)?
// Mirrors mailboxPointers' directory walk + POINTER_FILENAME filter but never
// reads, schema-validates, dedups, or folds a thread. counter.json never matches
// POINTER_FILENAME so it is ignored.
//
// This is a fail-toward-escalation detector, NOT a silent emptiness oracle: a
// present-and-readable mailbox with no pointer-named entry is the only "definitely
// nothing" answer (returns false). A MISSING, symlinked, or unreadable mailbox
// directory is corruption/deletion, not emptiness, so it THROWS -- the wait loop's
// interval tick catches the throw and escalates to the authoritative pollBus, which
// surfaces the real runtime_lost/corrupt cause instead of waiting to the deadline. A
// pointer-NAMED entry that is not a plain regular file (a symlink swap, FIFO, or dir)
// is also treated as a candidate so the authoritative poll inspects/quarantines it.
export async function mailboxHasPointerCandidate(paths: BusPaths, endpointId: string): Promise<boolean> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  // The mailbox is required; its `pending` child is created lazily, so only its absence
  // is benign. Each directory is lstat'd no-follow BEFORE and AFTER enumeration: a
  // symlinked directory (an attack that would redirect the scan outside the runtime) is
  // rejected, and a swap to a different inode during readdir is caught by the dev/ino
  // revalidation -- both escalate to the authoritative poll rather than trusting a
  // possibly-redirected listing.
  const targets: ReadonlyArray<{ readonly dir: string; readonly optional: boolean }> = [
    { dir: mailbox, optional: false },
    { dir: join(mailbox, "pending"), optional: true },
  ];
  for (const { dir, optional } of targets) {
    let before;
    try {
      before = await lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // ONLY absence at this INITIAL lstat is benign, and only for the optional pending
        // child (lazily created). The required mailbox being absent is deletion.
        if (optional) continue;
        throw new BusError("corrupt", `Mailbox directory is missing for endpoint ${endpointId}`, err);
      }
      throw new BusError("corrupt", `Mailbox directory is unreadable for endpoint ${endpointId}`, err);
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new BusError("corrupt", `Mailbox path for endpoint ${endpointId} is a symlink or not a directory`);
    }
    // The directory PROVABLY existed as of `before`. Any ENOENT from here on is a mid-scan
    // DELETION, not lazy absence, so it escalates regardless of `optional` -- otherwise a
    // pending dir removed after readdir could discard already-enumerated pointer entries
    // and report a false "empty".
    if (afterMailboxLstatHook) await afterMailboxLstatHook(dir); // test seam: mutate mid-scan
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new BusError("corrupt", `Mailbox directory vanished or became unreadable mid-scan for endpoint ${endpointId}`, err);
    }
    let after;
    try {
      after = await lstat(dir);
    } catch (err) {
      throw new BusError("corrupt", `Mailbox directory vanished during scan for endpoint ${endpointId}`, err);
    }
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new BusError("corrupt", `Mailbox directory identity changed during scan for endpoint ${endpointId}`);
    }
    for (const entry of entries) {
      if (POINTER_FILENAME.test(entry.name)) return true;
    }
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function recoverPendingIntent(
  paths: BusPaths,
  pointer: BusMailboxPointer,
): Promise<string | null> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const lockPath = await pathExists(join(paths.threads, pointer.threadId, "thread.json"))
    ? join(paths.locks, `thread-${pointer.threadId}.lock`)
    : join(paths.locks, "threads.lock");

  return withHardenedLock(lockPath, async () => {
    let folded: FoldedBusThread;
    try {
      folded = await foldBusThread(paths.projectRoot, pointer.threadId);
    } catch (err) {
      if (err instanceof BusError && err.code === "not_found") {
        await durableUnlink(pending);
        return null;
      }
      return `${filename}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const entry = folded.entries[pointer.entrySeq - 1];
    if (entry?.type === "message" && entry.entryHash === pointer.entryHash &&
        entry.payload.messageId === pointer.messageId && entry.payload.to === pointer.endpointId) {
      await activatePointer({ pending, active: join(mailbox, filename) });
      return null;
    }
    if (folded.integrity === "verified" || pointer.entrySeq > folded.validThroughSeq) {
      await durableUnlink(pending);
      return null;
    }
    return `${filename}: pending intent does not match the verified thread prefix`;
  });
}

async function reconcileEndpointMailbox(
  paths: BusPaths,
  endpoint: BusEndpoint,
  allEndpoints: readonly BusEndpoint[],
): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  const endpointId = endpoint.endpointId;
  return withHardenedLock(join(paths.locks, `mailbox-reconcile-${endpointId}.lock`), async () => {
    const mailbox = endpointMailboxPath(paths, endpointId);
    const findings: string[] = [];
    // ISS-872: this endpoint redelivers mail addressed to itself OR to any ancestor in
    // its bounded predecessor chain (a successor inherits its lineage's undelivered
    // mail). A corrupt chain fails closed to self-only and surfaces a finding.
    const { ids: addressees, corrupt: chainCorrupt } = endpointAddressees(endpoint, allEndpoints);
    if (chainCorrupt) findings.push(`succession chain: ${chainCorrupt}`);
    for (const filename of await listRegularJsonFiles(join(mailbox, "pending"))) {
      // A dot-prefixed pending intent is unexpected (temp files are never
      // dot-prefixed); report it rather than let the POINTER_FILENAME skip hide it.
      if (filename.startsWith(".")) {
        findings.push(`${filename}: unexpected dot-prefixed entry`);
        continue;
      }
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(mailbox, "pending", filename), BusMailboxPointerSchema);
        if (pointer.endpointId !== endpointId || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its endpoint or filename");
        }
        const finding = await recoverPendingIntent(paths, pointer);
        if (finding) findings.push(finding);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let current = await mailboxPointers(paths, endpointId);
    findings.push(...current.findings);
    const known = new Set(current.pointers.map((pointer) => pointer.messageId));
    for (const threadId of await listThreadIds(paths)) {
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, threadId);
      } catch (err) {
        findings.push(`${threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // A resolved thread is terminal: its messages need no delivery (checkBusShip exempts
      // them and the ship gate is already clear), so never recreate pointers for it.
      if (folded.state === "resolved") continue;
      for (const entry of folded.entries) {
        if (entry.type !== "message" || !addressees.includes(entry.payload.to) ||
            folded.acknowledgments.has(entry.payload.messageId) || known.has(entry.payload.messageId)) continue;
        const latest = await mailboxPointers(paths, endpointId);
        findings.push(...latest.findings);
        if (latest.pointers.some((pointer) => pointer.messageId === entry.payload.messageId)) {
          known.add(entry.payload.messageId);
          continue;
        }
        const mailboxSeq = await allocateMailboxSeq(paths, endpointId);
        // The pointer is stamped with THIS endpoint's id (it lives in this mailbox) even
        // when the thread entry's `to` is an ancestor; the read seams accept it because
        // the ancestor's `to` is in this endpoint's addressee set.
        const pointer = makePointer(endpointId, mailboxSeq, entry);
        try {
          await durableCreate(join(mailbox, pointerFilename(pointer)), serialize(pointer));
          known.add(entry.payload.messageId);
        } catch (err) {
          if (!(err instanceof BusError) || err.code !== "conflict") throw err;
        }
      }
    }

    // ISS-872 succession sweep. After redelivery, reclaim retired ancestors' now-
    // redundant pointer files so doctor stops flagging them -- but ONLY files that
    // parse, match their own envelope+filename, AND whose message is already
    // redelivered to this successor or already acked. Anything else (unparseable,
    // mismatched, or not-yet-redelivered) is PRESERVED as corruption/loss evidence
    // with a finding (mirrors mailboxPointers' fail-closed policy). Never unlink by
    // filename alone. Runs LAST so every unacked message keeps >=1 pointer throughout.
    const ancestors = addressees.filter((id) => id !== endpointId);
    if (ancestors.length > 0) {
      const foldCache = new Map<string, FoldedBusThread | null>();
      const foldFor = async (threadId: string): Promise<FoldedBusThread | null> => {
        if (!foldCache.has(threadId)) {
          try {
            foldCache.set(threadId, await foldBusThread(paths.projectRoot, threadId));
          } catch {
            foldCache.set(threadId, null);
          }
        }
        return foldCache.get(threadId) ?? null;
      };
      // Canonically-verified redelivered ids: a corrupt successor pointer (valid
      // envelope, wrong canonical binding) must NOT authorize deleting an ancestor's
      // only valid pointer, so require each successor pointer to match its canonical entry.
      const afterScan = await mailboxPointers(paths, endpointId);
      const delivered = new Set<string>();
      for (const pointer of afterScan.pointers) {
        if (pointerMatchesCanonical(await foldFor(pointer.threadId), pointer, addressees)) {
          delivered.add(pointer.messageId);
        }
      }
      for (const ancestorId of ancestors) {
        const ancestorMailbox = endpointMailboxPath(paths, ancestorId);
        for (const directory of [ancestorMailbox, join(ancestorMailbox, "pending")]) {
          for (const filename of await listRegularJsonFiles(directory)) {
            if (filename.startsWith(".")) {
              findings.push(`${ancestorId} mailbox: ${filename}: unexpected dot-prefixed entry`);
              continue;
            }
            if (!POINTER_FILENAME.test(filename)) continue;
            let pointer: BusMailboxPointer;
            try {
              pointer = await readJsonNoFollow(join(directory, filename), BusMailboxPointerSchema);
            } catch (err) {
              findings.push(`${ancestorId} mailbox: ${filename}: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            if (pointer.endpointId !== ancestorId || pointerFilename(pointer) !== filename) {
              findings.push(`${ancestorId} mailbox: ${filename}: pointer envelope does not match its endpoint or filename`);
              continue;
            }
            // Never unlink a pointer that does not match a VERIFIED canonical entry
            // (preserve corruption evidence, mirroring mailboxPointers' fail-closed policy).
            const folded = await foldFor(pointer.threadId);
            if (!pointerMatchesCanonical(folded, pointer, addressees)) {
              findings.push(`${ancestorId} mailbox: ${filename}: retained; pointer does not match a verified thread entry`);
              continue;
            }
            // Reclaimable when redelivered, already acked, or in a resolved (terminal)
            // thread -- none of which need a live pointer.
            const redundant = delivered.has(pointer.messageId) ||
              (folded?.acknowledgments.has(pointer.messageId) ?? false) ||
              folded?.state === "resolved";
            if (redundant) {
              await durableUnlink(join(directory, filename)).catch(() => undefined);
            } else {
              findings.push(`${ancestorId} mailbox: ${filename}: retained; message ${pointer.messageId} not yet redelivered to successor ${endpointId}`);
            }
          }
        }
      }
    }

    current = await mailboxPointers(paths, endpointId);
    return { pointers: current.pointers, findings: [...new Set([...findings, ...current.findings])] };
  });
}

// ISS-872: eager successor materialization. Runs reconcile's pointer-creation pass
// so a fresh successor's PHYSICAL mailbox holds its inherited pointers immediately
// after `setup --replace`, before any explicit poll. The live delivery hooks gate on
// the physical mailbox (readMailboxHighwater / mailboxHasPointerCandidate), so without
// this the inherited mail would stay invisible to the on-stop/on-tool tiers until the
// user happened to poll. reconcile advances NO delivery cursor (pollBus does that), so
// this does not mark the inherited mail as surfaced. Best-effort by contract: the
// caller treats a throw as a degraded-delivery signal and the next real poll's reconcile
// materializes idempotently, so mail is never lost, only deferred.
export type MaterializeStatus = "materialized" | "endpoint_inactive";

export async function materializeSuccessorMailbox(
  root: string,
  endpoint: BusEndpoint,
): Promise<{ status: MaterializeStatus; pointers: BusMailboxPointer[]; findings: string[] }> {
  if (materializeFailureHook) await materializeFailureHook();
  const paths = await resolveInitializedBusPaths(root);
  const { endpoints } = await listEndpoints(paths.projectRoot);
  // Trust the REGISTRY, not the caller-supplied object: a stale/forged record (or a
  // concurrent retire/replace between join and materialization) must never supply a
  // different predecessor chain than the current canonical endpoint. Look the endpoint up
  // by id and reconcile against that record only. A missing or retired record means there
  // is nothing to materialize for this endpoint -- reported as `endpoint_inactive` (not a
  // silent success) so the caller does not claim materialization completed.
  const canonical = endpoints.find((candidate) => candidate.endpointId === endpoint.endpointId);
  if (!canonical || canonical.retiredAt) return { status: "endpoint_inactive", pointers: [], findings: [] };
  const result = await reconcileEndpointMailbox(paths, canonical, endpoints);
  return { status: "materialized", ...result };
}

// ISS-872: read-only count of the distinct DELIVERABLE messages physically present in an
// endpoint's mailbox (canonically verified, unacknowledged, in an unresolved thread), so
// `setup --replace` reports only mail the successor will actually surface -- never
// acked/resolved/corrupt residue. Chain-aware: a message counts when its canonical
// recipient is any endpoint in this endpoint's bounded predecessor chain, so inherited
// mail (addressed to a retired predecessor) counts when read from the SUCCESSOR's mailbox
// after materialization has swept it across. A peer's chain is just itself, so a
// wrong-mailbox pointer addressed to someone outside the chain is still excluded. Counted
// AFTER replacement + materialization, so a message that arrived at the incumbent during
// the replacement window is included -- never a pre-mutation snapshot.
export async function countUndeliveredMessages(root: string, endpointId: string): Promise<number> {
  if (countFailureHook) await countFailureHook();
  const paths = await resolveInitializedBusPaths(root);
  const { endpoints } = await listEndpoints(paths.projectRoot);
  const canonical = endpoints.find((candidate) => candidate.endpointId === endpointId);
  const addressees = new Set(canonical ? endpointAddressees(canonical, endpoints).ids : [endpointId]);
  const { pointers } = await mailboxPointers(paths, endpointId);
  const foldCache = new Map<string, FoldedBusThread | null>();
  const counted = new Set<string>();
  for (const pointer of pointers) {
    if (!foldCache.has(pointer.threadId)) {
      try {
        foldCache.set(pointer.threadId, await foldBusThread(paths.projectRoot, pointer.threadId));
      } catch {
        foldCache.set(pointer.threadId, null);
      }
    }
    const folded = foldCache.get(pointer.threadId) ?? null;
    const entry = folded?.entries[pointer.entrySeq - 1];
    if (!folded || folded.integrity !== "verified" || folded.state === "resolved" ||
        !entry || entry.type !== "message" || entry.entryHash !== pointer.entryHash ||
        entry.payload.messageId !== pointer.messageId || !addressees.has(entry.payload.to) ||
        folded.acknowledgments.has(pointer.messageId)) continue;
    counted.add(entry.payload.messageId);
  }
  return counted.size;
}

async function pointerPaths(paths: BusPaths, pointer: BusMailboxPointer): Promise<string[]> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  return [join(mailbox, filename), join(mailbox, "pending", filename)];
}

async function removePointer(paths: BusPaths, pointer: BusMailboxPointer): Promise<void> {
  for (const path of await pointerPaths(paths, pointer)) await durableUnlink(path).catch(() => undefined);
}

export async function pollBus(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  limit?: number;
}): Promise<BusPollResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint, persist) => {
    const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    // ISS-872: load the endpoint list once so reconcile can redeliver inherited mail and
    // entry validation can accept any addressee in this endpoint's predecessor chain.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    const mailbox = await reconcileEndpointMailbox(paths, endpoint, allEndpoints);
    const messages: BusPollEnvelope[] = [];
    let cursor = endpoint.lastPolledMailboxSeq;

    for (const pointer of mailbox.pointers) {
      if (messages.length >= limit) break;
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, pointer.threadId);
      } catch (err) {
        mailbox.findings.push(`${pointer.threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const entry = folded.entries[pointer.entrySeq - 1];
      if (!entry || entry.type !== "message" || entry.entryHash !== pointer.entryHash ||
          entry.payload.messageId !== pointer.messageId || !addressees.includes(entry.payload.to)) {
        mailbox.findings.push(`${pointer.messageId}: mailbox pointer does not match the valid thread prefix`);
        continue;
      }
      await ensureDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      // Terminal: an acked message, or ANY message in a resolved thread, is not surfaced.
      // The pointer is reclaimed so it stops lingering (mirrors the reconcile sweep).
      if (folded.acknowledgments.has(pointer.messageId) || folded.state === "resolved") {
        await removePointer(paths, pointer);
        continue;
      }
      messages.push({
        source: "storybloq_bus",
        authority: "peer_agent",
        integrity: folded.integrity,
        sender: {
          endpointId: entry.payload.from.endpointId,
          client: entry.payload.from.client,
          role: derivedRole(entry.payload.kind),
        },
        threadId: pointer.threadId,
        mailboxSeq: pointer.mailboxSeq,
        message: entry.payload,
      });
      cursor = Math.max(cursor, pointer.mailboxSeq);
    }

    if (cursor !== endpoint.lastPolledMailboxSeq || messages.length > 0) {
      await persist((current) => ({
        ...current,
        lastPolledMailboxSeq: Math.max(current.lastPolledMailboxSeq, cursor),
        lastSeenAt: new Date().toISOString(),
      }));
    }
    return { endpointId: endpoint.endpointId, cursor, messages, findings: mailbox.findings };
  });
}

async function findMessageThread(paths: BusPaths, endpointId: string, messageId: string): Promise<string | null> {
  const mailbox = await mailboxPointers(paths, endpointId);
  const pointer = mailbox.pointers.find((candidate) => candidate.messageId === messageId);
  if (pointer) return pointer.threadId;
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.messages.some((message) => message.messageId === messageId)) return threadId;
  }
  return null;
}

function validateAckTransition(previous: BusAckPayload | undefined, next: BusAckPayload): "new" | "replay" {
  if (!previous) return "new";
  if (previous.disposition === next.disposition && previous.reason === next.reason) return "replay";
  if (previous.disposition === "deferred" && ["accepted", "rejected"].includes(next.disposition)) return "new";
  throw new BusError("conflict", `Cannot change ${previous.disposition} acknowledgment to ${next.disposition}`);
}

export async function acknowledgeBusMessage(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  messageId: string;
  disposition: "accepted" | "rejected" | "deferred";
  reason?: string;
}): Promise<{ threadId: string; replayed: boolean }> {
  if (!MessageIdSchema.safeParse(input.messageId).success) throw new BusError("invalid_input", "Invalid message id");
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  // D5 legacy-drain: ack a pending v1 message so the migration drain gate can clear.
  if (await classifyBusRuntime(root) === "v1") return ackV1(root, input);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    // ISS-872: a successor may ack mail addressed to any ancestor in its predecessor chain.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    const threadId = await findMessageThread(paths, endpoint.endpointId, input.messageId);
    if (!threadId) throw new BusError("not_found", "Bus message not found");
    return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
      let folded = await foldBusThread(paths.projectRoot, threadId);
      if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
      const message = folded.messages.find((candidate) => candidate.messageId === input.messageId);
      if (!message || !addressees.includes(message.to)) throw new BusError("unauthorized", "Message is not addressed to this endpoint");
      const reasonText = input.reason?.trim();
      if ((input.disposition === "rejected" || input.disposition === "deferred") && !reasonText) {
        throw new BusError("invalid_input", `A reason is required for ${input.disposition} acknowledgment`);
      }
      const reason = reasonText
        ? normalizeBusText(input.reason!, "Acknowledgment reason", 4096)
        : undefined;
      const payload: BusAckPayload = {
        messageId: input.messageId,
        byEndpoint: endpoint.endpointId,
        disposition: input.disposition,
        ...(reason ? { reason } : {}),
      };
      const transition = validateAckTransition(folded.acknowledgments.get(input.messageId), payload);
      if (transition === "replay") return { threadId, replayed: true };
      const entry = makeEntry({
        type: "ack",
        threadId,
        seq: folded.validThroughSeq + 1,
        prevHash: folded.lastHash,
        payload,
      });
      await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
      const pointers = await mailboxPointers(paths, endpoint.endpointId);
      for (const pointer of pointers.pointers.filter((candidate) => candidate.messageId === input.messageId)) {
        await removePointer(paths, pointer);
      }
      folded = await foldBusThread(paths.projectRoot, threadId);
      await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      return { threadId, replayed: false };
    });
  });
}

export async function getBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  return withEndpointCaller(root, input.endpointId, input.clientTaskId, async (endpoint) => {
    const folded = await foldBusThread(root, input.threadId);
    // ISS-872: a successor inherits participation in its predecessor chain's threads.
    const { endpoints: allEndpoints } = await listEndpoints(root);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    if (!addressees.some((id) => participantsInclude(folded.thread, id))) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    return folded;
  });
}

async function validateCommitEvidence(root: string, evidence: BusEvidenceRef): Promise<void> {
  if (!evidence.commit) return;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["rev-parse", "--verify", `${evidence.commit}^{commit}`], { cwd: root, timeout: 3000 }, (err) => {
      if (err) reject(new BusError("invalid_input", `Commit evidence does not resolve: ${evidence.commit}`));
      else resolve();
    });
  });
}

export async function updateBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
  action: "park" | "resolve" | "reopen";
  reason?: string;
  resolution?: string;
  evidence?: BusEvidenceRef;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) =>
    withHardenedLock(join(paths.locks, `thread-${input.threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, input.threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    // ISS-872: a successor inherits participation in its predecessor chain's threads.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    if (!endpointAddressees(endpoint, allEndpoints).ids.some((id) => participantsInclude(folded.thread, id))) {
      throw new BusError("unauthorized", "Endpoint is not a thread participant");
    }
    const reason = input.reason?.trim()
      ? normalizeBusText(input.reason, "Thread-state reason", 4096)
      : undefined;
    const resolution = input.resolution?.trim()
      ? normalizeBusText(input.resolution, "Thread resolution", 8192)
      : undefined;
    let evidence: BusEvidenceRef | undefined;
    if (input.evidence) {
      const parsed = BusEvidenceRefSchema.safeParse(input.evidence);
      if (!parsed.success) throw new BusError("invalid_input", "Invalid thread-state evidence");
      const ciRun = parsed.data.ciRun?.trim();
      if (parsed.data.ciRun && !ciRun) throw new BusError("invalid_input", "CI evidence cannot be empty");
      if (ciRun) assertNoHighConfidenceSecret(ciRun, "Thread-state evidence");
      evidence = {
        ...(parsed.data.commit ? { commit: parsed.data.commit.toLowerCase() } : {}),
        ...(ciRun ? { ciRun } : {}),
      };
    }
    if (input.action === "park" && (folded.state !== "open" || !reason)) {
      throw new BusError("invalid_input", "Parking an open thread requires a reason");
    }
    if (input.action === "resolve") {
      if (folded.state === "resolved" || !resolution || !evidence) {
        throw new BusError("invalid_input", "Resolving a thread requires resolution text and evidence");
      }
      if (folded.thread.kind === "issue_notice" && folded.thread.topicRef.issue) {
        const issue = loaded.state.issueByID(folded.thread.topicRef.issue);
        if (!issue || issue.status !== "resolved") {
          throw new BusError("conflict", "The canonical issue must be resolved before its Bus thread");
        }
      }
    }
    if (input.action === "reopen") {
      if (folded.state !== "parked" || !reason || !evidence) {
        throw new BusError("invalid_input", "Reopening a parked thread requires a reason and new evidence");
      }
      if (evidenceKeys(evidence).every((key) => folded.seenEvidence.has(key))) {
        throw new BusError("conflict", "Reopen evidence was already present before the park");
      }
    }
    if (evidence) await validateCommitEvidence(paths.projectRoot, evidence);
    const payload: BusStatePayload = {
      action: input.action,
      byEndpoint: endpoint.endpointId,
      ...(reason ? { reason } : {}),
      ...(resolution ? { resolution } : {}),
      ...(evidence ? { evidence } : {}),
    };
    folded = await appendStateEntry(paths, folded, payload);
    return folded;
    }),
  );
}

export interface BusDoctorResult {
  readonly healthy: boolean;
  readonly summary: BusSummary;
  readonly findings: readonly string[];
}

function emptyBusSummary(setupState: BusSetupState = "not_initialized"): BusSummary {
  const nextActions = setupState === "runtime_lost"
    ? ["The Bus runtime is absent or no longer matches this checkout's deletion-evidence; run: storybloq bus setup to re-establish it"]
    : ["run: storybloq bus setup"];
  return {
    enabled: setupState !== "disabled",
    initialized: false,
    daemonState: "stopped",
    setupState,
    deliveryMode: "poll",
    participants: [],
    nextActions,
    endpoints: 0,
    pendingMessages: 0,
    unacknowledgedCritical: 0,
    openThreads: 0,
    parkedThreads: 0,
    undeliverable: 0,
    quarantined: 0,
    hookDelivery: { claude: false, codex: false },
    deliveryCapabilities: { onStop: "none", onTool: "none" },
  };
}

async function receiptEndpointDirs(paths: BusPaths): Promise<{ dirs: string[]; findings: string[] }> {
  let entries;
  try {
    entries = await readdir(paths.idempotency, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { dirs: [], findings: [] };
    // A non-ENOENT enumeration failure (EACCES, EIO, ...) must be reported as a doctor
    // finding rather than thrown: busDoctor calls this outside a catch, so throwing here
    // aborts the whole health report instead of returning healthy:false with a reason.
    return { dirs: [], findings: [`idempotency: cannot enumerate: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const dirs: string[] = [];
  const findings: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && EndpointIdSchema.safeParse(entry.name).success) {
      dirs.push(entry.name);
    } else {
      findings.push(`idempotency: unexpected entry ${entry.name}`);
    }
  }
  return { dirs, findings };
}

export async function busDoctor(root: string): Promise<BusDoctorResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  // D5 legacy-drain: report v1 content read-only, without migrating.
  if (await classifyBusRuntime(root) === "v1") return doctorV1(root);
  const paths = await resolveBusPaths(root, false);
  // T-428: loss/evidence classification. A present runtime's validation throw is
  // surfaced as a finding (today's behavior), never downgraded.
  let assessment: BusRuntimeAssessment;
  try {
    assessment = await assessBusRuntimeAtPaths(paths);
  } catch (err) {
    return { healthy: false, summary: emptyBusSummary("invalid"), findings: [`instance: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (assessment.kind === "lost") {
    return { healthy: false, summary: emptyBusSummary("runtime_lost"), findings: [runtimeLostError(assessment).message] };
  }
  if (assessment.kind === "evidence_corrupt") {
    // `bus setup` fails CLOSED on corrupt evidence (it refuses to overwrite loss
    // history), so the guidance must match: inspect or remove the file first.
    return { healthy: false, summary: emptyBusSummary("invalid"), findings: [`deletion-evidence: unreadable (${assessment.detail}); inspect or remove \`.story/.bus-evidence.json\`, then run \`storybloq bus setup\``] };
  }
  if (assessment.kind === "fresh") {
    return { healthy: true, summary: emptyBusSummary(), findings: [] };
  }
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) {
    return { healthy: false, summary: emptyBusSummary("invalid"), findings };
  }
  try {
    await readBusInstance(paths.projectRoot);
  } catch (err) {
    findings.push(`instance: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    for (const entry of await readdir(paths.locks, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".reap")) {
        findings.push(`lock recovery guard requires explicit owner inspection: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`locks: ${err instanceof Error ? err.message : String(err)}`);
  }
  const endpoints = await listEndpoints(paths.projectRoot);
  findings.push(...endpoints.findings.map((finding) => `endpoint: ${finding}`));
  const activeEndpoints = endpoints.endpoints.filter((candidate) => !candidate.retiredAt);
  if (activeEndpoints.length > 2) {
    findings.push(`two-endpoint invariant violated: ${activeEndpoints.length} active endpoints`);
  }
  const retiredIds = new Set(endpoints.endpoints.filter((candidate) => candidate.retiredAt).map((candidate) => candidate.endpointId));

  const folds: FoldedBusThread[] = [];
  try {
    for (const entry of await readdir(paths.threads, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) findings.push(`thread staging directory was not published: ${entry.name}`);
      else if (entry.isDirectory() && !ThreadIdSchema.safeParse(entry.name).success) {
        findings.push(`invalid thread directory: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`threads: ${err instanceof Error ? err.message : String(err)}`);
  }
  const liveThreadIds = new Set<string>();
  for (const threadId of await listThreadIds(paths)) {
    liveThreadIds.add(threadId);
    try {
      const folded = await foldBusThread(paths.projectRoot, threadId);
      folds.push(folded);
      if (folded.integrity !== "verified") findings.push(`thread ${threadId}: ${folded.finding ?? "quarantined"}`);
    } catch (err) {
      findings.push(`thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ISS-872: threadId -> folded index so a retired mailbox's pointers can be validated
  // and classified per-pointer against their canonical entry (a broken chain can leave
  // one retired mailbox holding a mix of redeliverable, resolvable, and stranded pointers).
  const foldByThread = new Map<string, FoldedBusThread>();
  for (const folded of folds) foldByThread.set(folded.thread.threadId, folded);
  for (const endpoint of endpoints.endpoints) {
    const mailbox = await mailboxPointers(paths, endpoint.endpointId);
    findings.push(...mailbox.findings.map((finding) => `${endpoint.endpointId} mailbox: ${finding}`));
    // ISS-872: a corrupt predecessor chain on an ACTIVE endpoint never grants authority
    // (it fails closed to self-only at the read seams); surface it here deterministically.
    if (!endpoint.retiredAt) {
      const chainCorrupt = endpointAddressees(endpoint, endpoints.endpoints).corrupt;
      if (chainCorrupt) findings.push(`${endpoint.endpointId} succession chain: ${chainCorrupt}`);
    }
    if (retiredIds.has(endpoint.endpointId) && mailbox.pointers.length > 0) {
      // Per-pointer, chain- and participant-aware classification (three tiers):
      //  1. REDELIVERABLE -- an active endpoint whose chain covers BOTH this retired
      //     mailbox owner (so it actually sweeps this mailbox) AND the pointer's canonical
      //     recipient; it surfaces the mail on its next poll.
      //  2. RESOLVABLE -- not redeliverable, but an active endpoint is authorized over the
      //     thread (its addressees include a thread participant), so that participant can
      //     resolve the thread with evidence to clear the ship gate.
      //  3. STRANDED -- neither: every participant AND lineage successor has retired, the
      //     pre-existing all-participants-retired defect (see ISS-873). Content is
      //     recoverable read-only via `bus export`, but the gate cannot be cleared.
      // A pointer that does not match a VERIFIED canonical entry (quarantined thread,
      // wrong hash/id/entrySeq, or a missing message) is unclassifiable: reconcile and
      // poll can neither validate nor deliver it, so it is counted as corruption, never
      // given a false recovery instruction.
      // A pointer's stale residue is reclaimed by an active chain-successor's reconcile
      // sweep; when NO active endpoint's chain covers this retired mailbox, nothing sweeps
      // it, so the wording must not promise a poll-based cleanup that can never run.
      const hasActiveSuccessor = activeEndpoints.some((active) =>
        endpointAddressees(active, endpoints.endpoints).ids.includes(endpoint.endpointId));
      // Mail may legitimately sit in THIS retired mailbox only if it is addressed to the
      // owner or one of the owner's own predecessors (mail the owner inherited). The set is
      // constant per endpoint, so compute it once. A canonically valid pointer addressed
      // OUTSIDE this set is misfiled -- no active successor's reconcile sweep will ever
      // reclaim it (reconcile only accepts recipients in ITS chain), so it must be counted
      // as corruption, never as routine stale state that falsely promises a poll cleanup.
      const ownerAddressees = endpointAddressees(endpoint, endpoints.endpoints).ids;
      let redeliverable = 0;
      let corruptPointers = 0;
      let stalePointers = 0;
      const resolvableThreads = new Set<string>();
      const strandedThreads = new Set<string>();
      let successorId: string | undefined;
      for (const pointer of mailbox.pointers) {
        const folded = foldByThread.get(pointer.threadId);
        const entry = folded?.entries[pointer.entrySeq - 1];
        if (!folded || folded.integrity !== "verified" || !entry || entry.type !== "message" ||
            entry.entryHash !== pointer.entryHash || entry.payload.messageId !== pointer.messageId) {
          corruptPointers += 1;
          continue;
        }
        // A canonically bound but MISFILED pointer (recipient outside the owner's own chain)
        // is corruption regardless of acked/resolved state: no sweep reclaims it, so it must
        // never be reported as routine stale cleanup with a false successor-poll promise.
        if (!ownerAddressees.includes(entry.payload.to)) {
          corruptPointers += 1;
          continue;
        }
        // A pointer whose message is already acked, or whose thread is already resolved,
        // needs NO recovery: the ship gate is already clear and the next reconcile sweep
        // reclaims it. Classify as routine stale cleanup, never redeliverable/resolvable/
        // stranded (which would imply an unnecessary or impossible action).
        if (folded.acknowledgments.has(pointer.messageId) || folded.state === "resolved") {
          stalePointers += 1;
          continue;
        }
        const recipient = entry.payload.to;
        const successor = activeEndpoints.find((active) => {
          const ids = endpointAddressees(active, endpoints.endpoints).ids;
          return ids.includes(endpoint.endpointId) && ids.includes(recipient);
        });
        if (successor) {
          redeliverable += 1;
          successorId = successor.endpointId;
          continue;
        }
        // RESOLVABLE requires a VERIFIED thread (updateBusThread rejects every transition
        // on a quarantined thread) with an active authorized participant.
        const resolvable = activeEndpoints.some((active) =>
          endpointAddressees(active, endpoints.endpoints).ids.some((id) => participantsInclude(folded.thread, id)));
        if (resolvable) resolvableThreads.add(pointer.threadId);
        else strandedThreads.add(pointer.threadId);
      }
      if (redeliverable > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${redeliverable} undelivered pointer(s) pending redelivery to successor ${successorId}; poll that endpoint to surface them`);
      }
      if (resolvableThreads.size > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${resolvableThreads.size} undelivered thread(s) to a retired recipient; the thread's active participant can resolve it with evidence to clear the ship gate`);
      }
      if (strandedThreads.size > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${strandedThreads.size} stranded succession thread(s) with no active participant or successor; recover the content read-only with \`storybloq bus export <thread-id>\`; the thread cannot be acked or resolved until an active participant exists.`);
      }
      if (stalePointers > 0) {
        findings.push(hasActiveSuccessor
          ? `${endpoint.endpointId} mailbox: ${stalePointers} acknowledged/resolved pointer(s) pending routine sweep; no action needed (a poll of the owning successor reclaims them).`
          : `${endpoint.endpointId} mailbox: ${stalePointers} acknowledged/resolved pointer(s) are non-blocking stale state with no active successor to reclaim them; the ship gate is already clear.`);
      }
      if (corruptPointers > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${corruptPointers} pointer(s) that do not match a verified thread entry addressed to this mailbox; run \`storybloq bus doctor\` on the affected thread and recover content with \`storybloq bus export <thread-id>\`.`);
      }
    }
    const pendingCount = (await listRegularJsonFiles(join(endpointMailboxPath(paths, endpoint.endpointId), "pending")))
      .filter((filename) => POINTER_FILENAME.test(filename)).length;
    if (pendingCount > 0) findings.push(`${endpoint.endpointId} mailbox: ${pendingCount} pending intent(s) require poll recovery`);
    const maxSeq = mailbox.pointers.reduce((maximum, pointer) => Math.max(maximum, pointer.mailboxSeq), 0);
    try {
      const counter = await readJsonNoFollow(
        join(endpointMailboxPath(paths, endpoint.endpointId), "counter.json"),
        BusMailboxCounterSchema,
      );
      if (counter.nextSeq <= maxSeq) findings.push(`${endpoint.endpointId} mailbox counter is behind sequence ${maxSeq}`);
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found" || maxSeq > 0) {
        findings.push(`${endpoint.endpointId} mailbox counter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Orphan mailboxes: a UUID-named mailbox dir left after its endpoint record was
  // deleted is never reached by the per-endpoint loop above, so it (and any unread
  // pointers it still holds) would go unseen. Enumerate the mailboxes dir and report
  // any UUID-named directory with no matching endpoint record as an orphan finding.
  const registeredEndpointIds = new Set(endpoints.endpoints.map((endpoint) => endpoint.endpointId));
  try {
    for (const entry of await readdir(paths.mailboxes, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      // A dot-prefixed entry is unexpected where only `<uuid>` mailbox dirs belong
      // (temp files are never dot-prefixed): report it rather than silently skip a
      // mailbox renamed `<uuid>` -> `.<uuid>` to hide it from the orphan scan.
      if (entry.name.startsWith(".")) {
        findings.push(`mailboxes: unexpected dot-prefixed entry ${entry.name}`);
        continue;
      }
      if (registeredEndpointIds.has(entry.name)) continue;
      // A non-directory, symlink, or non-UUID entry where only `<uuid>` mailbox dirs
      // belong is unexpected: report it rather than silently skip a file or symlink
      // named like an endpoint. Registered endpoints are skipped first because
      // busLayoutFindings already enforced their directory shape and short-circuits
      // doctor before this scan (mirrors the top-level idempotency scan's else-branch).
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          !EndpointIdSchema.safeParse(entry.name).success) {
        findings.push(`mailboxes: unexpected entry ${entry.name} is not a regular <uuid> mailbox directory`);
        continue;
      }
      const orphanDir = join(paths.mailboxes, entry.name);
      const pointerCount = (await listRegularJsonFiles(orphanDir)).filter((name) => POINTER_FILENAME.test(name)).length;
      // The orphan ROOT was validated above as a real non-symlink directory, but its
      // `pending` CHILD was not. A preserved orphan whose `pending` is a symlink would
      // otherwise make listRegularJsonFiles follow it and enumerate an arbitrary external
      // directory. lstat it (no-follow) and report a finding instead of traversing; a
      // missing pending is a benign zero, any other stat error is surfaced fail-closed.
      const pendingDir = join(orphanDir, "pending");
      let pendingDescription: string;
      try {
        const pendingStat = await lstat(pendingDir);
        if (pendingStat.isSymbolicLink() || !pendingStat.isDirectory()) {
          pendingDescription = "pending is not a regular directory";
        } else {
          const pendingCount = (await listRegularJsonFiles(pendingDir)).filter((name) => POINTER_FILENAME.test(name)).length;
          pendingDescription = `${pendingCount} pending intent(s)`;
        }
      } catch (err) {
        pendingDescription = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "0 pending intent(s)"
          : `pending unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
      findings.push(`orphan mailbox ${entry.name}: ${pointerCount} pointer(s), ${pendingDescription} with no endpoint record`);
    }
  } catch (err) {
    findings.push(`mailboxes: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Orphaned receipts (thread gone) + receipt integrity.
  const receiptDirs = await receiptEndpointDirs(paths);
  findings.push(...receiptDirs.findings);
  for (const endpointId of receiptDirs.dirs) {
    const receiptDir = join(paths.idempotency, endpointId);
    let receiptEntries;
    try {
      receiptEntries = await readdir(receiptDir, { withFileTypes: true });
    } catch (err) {
      findings.push(`receipt ${endpointId}: cannot enumerate: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const dirent of receiptEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A dot-prefixed name is NOT skipped: temp files are never dot-prefixed, so a
      // receipt renamed `<keyHash>.json` -> `.<keyHash>.json` is unexpected and falls
      // through to the finding below rather than being silently hidden, which would
      // otherwise let a retry republish a duplicate.
      if (dirent.name === "." || dirent.name === "..") continue;
      const filename = dirent.name;
      // A symlink, a non-regular file, or a name that is not `<keyHash>.json` is an
      // unexpected entry where only receipts belong. Enumerating (rather than
      // listRegularJsonFiles, which silently drops these) makes a receipt renamed
      // away from `.json` visible; otherwise a retry republishes a duplicate silently.
      if (!dirent.isFile() || dirent.isSymbolicLink() || !RECEIPT_FILENAME.test(filename)) {
        findings.push(`receipt ${endpointId}/${filename}: not a regular <keyHash>.json file`);
        continue;
      }
      try {
        const receipt = await readJsonNoFollow(join(receiptDir, filename), BusReceiptSchema);
        if (receipt.endpointId !== endpointId) {
          findings.push(`receipt ${endpointId}/${filename}: endpointId ${receipt.endpointId} does not match its directory`);
        }
        if (filename !== `${receipt.keyHash}.json`) {
          findings.push(`receipt ${endpointId}/${filename}: does not match its key hash`);
        }
        if (!liveThreadIds.has(receipt.threadId)) {
          findings.push(`receipt ${endpointId}/${filename}: references missing thread ${receipt.threadId}`);
        }
      } catch (err) {
        findings.push(`receipt ${endpointId}/${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const filename of await listRegularJsonFiles(paths.succession)) {
    try {
      const record = await readJsonNoFollow(join(paths.succession, filename), BusSuccessionSchema);
      if (filename !== `${record.successionId}.json`) {
        findings.push(`succession: ${filename} does not match its record id`);
      }
    } catch (err) {
      findings.push(`succession ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await readBusHookPolicy(paths.projectRoot);
  } catch (err) {
    findings.push(`hook policy: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = await summarizeFrom(paths, loaded.state, endpoints.endpoints, endpoints.findings, folds);
  return { healthy: findings.length === 0, summary, findings };
}

function deriveSetupState(activeCount: number): BusSetupState {
  if (activeCount > 2) return "invalid";
  if (activeCount === 2) return "ready";
  if (activeCount === 1) return "waiting_for_peer";
  return "disconnected";
}

function deriveDeliveryMode(
  participants: readonly BusParticipantSummary[],
  hookDelivery: { claude: boolean; codex: boolean },
): BusDeliveryMode {
  const clients = [...new Set(participants.map((participant) => participant.client))];
  if (clients.length === 0) return "poll";
  const on = clients.filter((client) => hookDelivery[client]);
  if (on.length === clients.length) return "live";
  if (on.length === 0) return "poll";
  return "partial";
}

// T-427: an active claude endpoint is on-tool active only when its project opted
// its client into hook delivery AND the PostToolUse hook has proven it fired in
// this endpoint's CURRENTLY-BOUND session (activation identity match). A session
// rebind leaves a stale activation whose taskId no longer matches, so it correctly
// reverts to inactive until the new session's hook fires.
function endpointToolActive(
  endpoint: BusEndpoint,
  hookDelivery: { claude: boolean; codex: boolean },
): boolean {
  if (endpoint.client !== "claude" || !hookDelivery.claude) return false;
  const activation = endpoint.toolHookActivation;
  return activation != null && activation.taskId === endpoint.clientTaskId;
}

// T-427 honest, structured coverage over the ACTIVE endpoints. onStop is the
// reliable turn-boundary channel (both clients have a Stop hook), so it is a
// tri-state over the distinct participant clients keyed on hook policy. onTool is
// the mid-turn PostToolUse channel, which is Claude-only, and is computed per ACTIVE
// ENDPOINT (never per distinct client) so it cannot overstate coverage: with two
// active Claude sessions, one fired hook does NOT read as "all". This never asserts
// guaranteed mid-turn ingestion; it reports only that the hook is enabled (policy)
// and proven firing (activation).
function deriveDeliveryCapabilities(
  active: readonly BusEndpoint[],
  hookDelivery: { claude: boolean; codex: boolean },
): BusDeliveryCapabilities {
  const clients = [...new Set(active.map((endpoint) => endpoint.client))];
  if (clients.length === 0) return { onStop: "none", onTool: "none" };
  const stopOn = clients.filter((client) => hookDelivery[client]);
  const onStop = stopOn.length === 0 ? "none" : stopOn.length === clients.length ? "all" : "partial";
  const claudeEndpoints = active.filter((endpoint) => endpoint.client === "claude");
  const hasCodex = active.some((endpoint) => endpoint.client === "codex");
  const claudeToolActive = claudeEndpoints.filter((endpoint) => endpointToolActive(endpoint, hookDelivery)).length;
  let onTool: BusDeliveryCapabilities["onTool"];
  if (claudeToolActive === 0) {
    onTool = "none";
  } else if (claudeToolActive < claudeEndpoints.length) {
    // Some but not all active Claude sessions have fired the hook.
    onTool = "partial";
  } else if (hasCodex) {
    // Every active Claude session is tool-active, but a Codex peer has no PostToolUse.
    onTool = "claude_only";
  } else {
    onTool = "all";
  }
  return { onStop, onTool };
}

function deriveNextActions(setupState: BusSetupState, deliveryMode: BusDeliveryMode): string[] {
  if (setupState === "disconnected" || setupState === "not_initialized" || setupState === "disabled") {
    return ["run: storybloq bus setup"];
  }
  if (setupState === "invalid") return ["run: storybloq bus doctor"];
  if (setupState === "waiting_for_peer") return ["run: storybloq bus setup (in the peer task)"];
  if (deliveryMode !== "live") return ["run: storybloq bus setup --delivery live (in each task)"];
  return [];
}

async function summarizeFrom(
  paths: BusPaths,
  state: ProjectState,
  endpoints: readonly BusEndpoint[],
  registryFindings: readonly string[],
  suppliedFolds?: readonly FoldedBusThread[],
): Promise<BusSummary> {
  const folds = suppliedFolds ? [...suppliedFolds] : await Promise.all(
    (await listThreadIds(paths)).map((threadId) => foldBusThread(paths.projectRoot, threadId)),
  );
  const pendingIds = new Set<string>();
  let unacknowledgedCritical = 0;
  for (const folded of folds) {
    for (const message of folded.messages) {
      if (!folded.acknowledgments.has(message.messageId)) {
        pendingIds.add(message.messageId);
        if (message.severity === "critical") unacknowledgedCritical += 1;
      }
    }
  }
  let hookDelivery = { claude: false, codex: false };
  try {
    const policy = await readBusHookPolicy(paths.projectRoot);
    hookDelivery = { claude: policy.claude, codex: policy.codex };
  } catch {
    // Doctor reports policy corruption; status remains available.
  }
  const active = endpoints.filter((endpoint) => !endpoint.retiredAt);
  const participants: BusParticipantSummary[] = active.map((endpoint) => ({
    client: endpoint.client,
    surface: endpoint.surface,
    state: endpoint.state,
  }));
  // A corrupt endpoint registry (a malformed record dropped from the parsed set)
  // makes readiness `invalid`, matching the v1 summary and the send path, which
  // fails closed on registry findings. Reporting `ready` off only the count of
  // successfully parsed endpoints would mask that corruption.
  const setupState = registryFindings.length > 0 ? "invalid" : deriveSetupState(active.length);
  const deliveryMode = deriveDeliveryMode(participants, hookDelivery);
  return {
    enabled: true,
    initialized: true,
    daemonState: "stopped",
    setupState,
    deliveryMode,
    participants,
    nextActions: deriveNextActions(setupState, deliveryMode),
    endpoints: active.length,
    pendingMessages: pendingIds.size,
    unacknowledgedCritical,
    openThreads: folds.filter((folded) => folded.state === "open").length,
    parkedThreads: folds.filter((folded) => folded.state === "parked").length,
    undeliverable: 0,
    quarantined: folds.filter((folded) => folded.integrity !== "verified").length,
    hookDelivery,
    deliveryCapabilities: deriveDeliveryCapabilities(active, hookDelivery),
  };
}

// T-428: the config-revert diagnostic (doctor / status only). When features.bus
// is off but this checkout carries evidence of an instance it stood up, the
// config was likely reverted; surface it loudly. Ops still fail closed with
// bus_disabled unchanged.
export async function busConfigRevertNote(root: string, paths?: BusPaths): Promise<string | null> {
  const p = paths ?? await resolveBusPaths(root, false).catch(() => null);
  if (!p) return null;
  const ev = await readBusEvidence(p);
  if (ev.kind === "present" && ev.evidence.instanceId) {
    return `This checkout initialized Bus instance ${ev.evidence.instanceId} but config.features.bus is no longer set (config may have been reverted); run \`storybloq bus setup\`.`;
  }
  return null;
}

// Advisory for a pre-T-428 runtime that has no deletion-evidence yet. Setup adopts
// it (writes evidence); until then a deletion cannot be detected.
const BUS_LEGACY_UNMIRRORED_ADVISORY =
  "run: storybloq bus setup (to enable deletion-evidence for this pre-existing runtime)";

// T-428: a one-line advisory for the guarded hooks (SessionStart / Stop) when this
// checkout's Bus runtime was deleted (evidence names an instance but the runtime is
// gone or was swapped). Returns null when the runtime is fine, never set up, or on
// ANY error -- hooks are fail-open and this must never throw. Callers emit it via a
// structured context field or STDERR only, never bare stdout.
export async function busRuntimeLostAdvisory(root: string): Promise<string | null> {
  try {
    // Gate on features.bus: a checkout that never enabled the Bus (or deliberately
    // disabled it) must not receive a runtime-lost advisory from these fail-open
    // hooks. The disabled-but-evidence-present case is surfaced by
    // busConfigRevertNote in status/doctor instead.
    const { state } = await loadProject(root);
    if (!isBusEnabled(state.config)) return null;
    const assessment = await assessBusRuntime(root);
    if (assessment.kind !== "lost") return null;
    // `lost` covers both an ABSENT runtime and a PRESENT runtime whose instance no
    // longer matches this checkout's evidence (a swap); diagnose each accurately.
    const detail = assessment.reason === "absent"
      ? `the .story/bus/ runtime (instance ${assessment.expectedInstanceId}) was deleted from this checkout`
      : `the .story/bus/ runtime no longer matches this checkout (expected instance ${assessment.expectedInstanceId}, found ${assessment.foundInstanceId})`;
    return `[storybloq-bus] runtime lost: ${detail}. Prior peer coordination is gone; run \`storybloq bus setup\` to re-establish the Bus.`;
  } catch {
    return null;
  }
}

export async function busSummary(root: string, state?: ProjectState): Promise<BusSummary> {
  const loadedState = state ?? (await loadProject(root)).state;
  if (!isBusEnabled(loadedState.config)) {
    // A disabled project must not depend on resolving the (possibly absent or
    // tampered) bus paths; busConfigRevertNote resolves them defensively (catch->
    // null), so a symlinked `.story/bus` yields no note instead of throwing here.
    const summary = emptyBusSummary("disabled");
    const note = await busConfigRevertNote(root);
    return note ? { ...summary, nextActions: [note, ...summary.nextActions] } : summary;
  }
  const paths = await resolveBusPaths(root, false);
  // D5 legacy-drain: surface v1 status read-only, without migrating.
  if (await classifyBusRuntime(root) === "v1") return summarizeV1(root);
  // T-428: classify loss/evidence before the happy path.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") return emptyBusSummary("runtime_lost");
  if (assessment.kind === "evidence_corrupt") return emptyBusSummary("invalid");
  if (assessment.kind === "fresh") return emptyBusSummary();
  await assertBusLayout(paths);
  const scan = await listEndpoints(paths.projectRoot);
  const summary = await summarizeFrom(paths, loadedState, scan.endpoints, scan.findings);
  if (assessment.kind === "legacy_unmirrored") {
    return { ...summary, nextActions: [BUS_LEGACY_UNMIRRORED_ADVISORY, ...summary.nextActions] };
  }
  return summary;
}

export interface BusShipCheck {
  readonly clear: boolean;
  readonly blockers: readonly string[];
}

export async function checkBusShip(root: string): Promise<BusShipCheck> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, false);
  // T-428: a lost or evidence-corrupt runtime blocks the ship gate.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") return { clear: false, blockers: [runtimeLostError(assessment).message] };
  if (assessment.kind === "evidence_corrupt") {
    return { clear: false, blockers: [`Bus deletion-evidence is unreadable (${assessment.detail}); run \`storybloq bus doctor\``] };
  }
  if (assessment.kind === "fresh") return { clear: true, blockers: [] };
  await assertBusLayout(paths);
  await readBusInstance(paths.projectRoot);
  const blockers: string[] = [];
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    const issue = folded.thread.topicRef.issue
      ? loaded.state.issueByID(folded.thread.topicRef.issue)
      : undefined;
    const critical = issue?.severity === "critical" || folded.messages.some((message) => message.severity === "critical");
    if (!critical) continue;
    const label = issue ? displayIdOf(issue) : `Bus thread ${threadId}`;
    if (folded.integrity !== "verified") blockers.push(`${label}: quarantined Bus thread ${threadId}`);
    // A resolved thread has concluded through the state machine's `resolve` action,
    // which requires resolution text AND evidence (commit/CI ref) from a participant.
    // That evidenced terminal state supersedes a per-message ack, so it clears the
    // unacked-critical blocker. This is also the ONLY recovery for a critical message
    // whose addressed recipient has retired: that endpoint can never ack it, so
    // without this exemption the blocker would be permanent. A quarantined thread is
    // NOT exempted above (a tampered thread cannot be trusted to be "resolved").
    if (folded.state !== "resolved" &&
        folded.messages.some((message) => message.severity === "critical" && !folded.acknowledgments.has(message.messageId))) {
      blockers.push(`${label}: unacknowledged critical Bus message`);
    }
    if (folded.state === "parked" && (!issue || issue.status !== "resolved")) {
      blockers.push(`${label}: parked Bus thread with unresolved critical issue`);
    }
  }
  return { clear: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function exportBusThread(root: string, threadId: string, format: "json" | "md"): Promise<string> {
  // D5 legacy-drain: read a live v1 thread pre-migration; post-migration a v2 fold
  // that misses falls back to the archived v1 tree (archive/v1/threads).
  if (await classifyBusRuntime(root) === "v1") return exportV1Thread(root, threadId, format);
  // T-428: classify exhaustively BEFORE folding so the v1-archive fallback is
  // reserved for a valid present v2 genuine thread miss. A lost / evidence-corrupt
  // / fresh runtime must surface its own error, never be masked by the archive.
  const paths = await resolveBusPaths(root, false);
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") throw runtimeLostError(assessment);
  if (assessment.kind === "evidence_corrupt") {
    throw new BusError("corrupt", `Bus deletion-evidence is unreadable (${assessment.detail}). Run \`storybloq bus doctor\`.`);
  }
  if (assessment.kind === "fresh") {
    throw new BusError("not_found", "Bus is not initialized in this checkout. Run `storybloq bus setup` first.");
  }
  // ok | legacy_unmirrored: assert the full v2 layout BEFORE folding so a PARTIAL or
  // corrupt runtime surfaces as `corrupt` here, matching busSummary/checkBusShip. A
  // genuine thread miss on a valid layout is the only case that reaches the archive
  // fallback below; a missing structural dir must never be masked by it.
  await assertBusLayout(paths);
  let folded: FoldedBusThread;
  try {
    folded = await foldBusThread(root, threadId);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      return exportV1Thread(root, threadId, format, "archive");
    }
    throw err;
  }
  if (format === "json") {
    return JSON.stringify({
      thread: folded.thread,
      entries: folded.entries,
      state: folded.state,
      hopCount: folded.hopCount,
      integrity: folded.integrity,
      finding: folded.finding ?? null,
    }, null, 2);
  }
  const lines = [
    `# Storybloq Bus thread ${threadId}`,
    "",
    `Kind: ${folded.thread.kind} | State: ${folded.state} | Integrity: ${folded.integrity}`,
    `Topic: ${JSON.stringify(folded.thread.topicRef)}`,
    "",
  ];
  for (const entry of folded.entries) {
    if (entry.type === "message") {
      const role = derivedRole(entry.payload.kind);
      const label = role ? `${role} (${entry.payload.kind})` : entry.payload.kind;
      lines.push(`## ${entry.seq}. ${label}`, "", entry.payload.body, "");
    } else {
      lines.push(`## ${entry.seq}. ${entry.type}`, "", "```json", JSON.stringify(entry.payload, null, 2), "```", "");
    }
  }
  return lines.join("\n").trimEnd();
}

export async function pendingMailboxCursor(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<{ cursor: number; count: number }> {
  const paths = await resolveBusPaths(root, false);
  // Endpoint-scoped read: prove caller ownership under the endpoint lock (D2),
  // so a forged endpoint hint cannot inspect another endpoint's pending cursor.
  return withEndpointCaller(paths.projectRoot, endpointId, clientTaskId, async () => {
    const mailbox = await mailboxPointers(paths, endpointId);
    let cursor = 0;
    let count = 0;
    for (const pointer of mailbox.pointers) {
      try {
        const folded = await foldBusThread(paths.projectRoot, pointer.threadId);
        const entry = folded.entries[pointer.entrySeq - 1];
        if (entry?.type === "message" && entry.payload.messageId === pointer.messageId &&
            !folded.acknowledgments.has(pointer.messageId)) {
          cursor = Math.max(cursor, pointer.mailboxSeq);
          count += 1;
        }
      } catch {
        // Hook delivery fails open; doctor provides the durable diagnostic.
      }
    }
    return { cursor, count };
  });
}

export const __storeTesting = {
  setAfterMailboxLstatHook: (fn: ((dir: string) => Promise<void>) | null) => { afterMailboxLstatHook = fn; },
  // ISS-872: force the best-effort eager materialization to fail so tests can exercise
  // the degraded-delivery (needs-explicit-poll) path without racing a real I/O fault.
  setMaterializeFailureHook: (fn: (() => Promise<void>) | null) => { materializeFailureHook = fn; },
  // ISS-872: force the post-mutation undelivered-count read to fail so tests can prove
  // setup still returns a resumable result (never throws) after joinEndpoint has mutated.
  setCountFailureHook: (fn: (() => Promise<void>) | null) => { countFailureHook = fn; },
};
