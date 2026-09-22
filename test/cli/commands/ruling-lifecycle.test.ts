import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleRulingList,
  handleRulingGet,
  handleRulingCreate,
  handleRulingSupersede,
  handleRulingPropose,
  handleRulingAccept,
  handleRulingWithdraw,
} from "../../../src/cli/commands/ruling.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { payloadDigest } from "../../../src/core/ruling-lifecycle.js";
import type { CommandContext } from "../../../src/cli/types.js";

/**
 * T-522 plan section 4: the CLI lifecycle handlers, driven end to end on a
 * real project so every write goes through the lock, the transaction and the
 * loader exactly as a user's does.
 *
 * RED against 21025fb4: `handleRulingPropose`, `handleRulingAccept` and
 * `handleRulingWithdraw` do not exist; `create` writes no acceptance; `list`
 * has no status filter; `get` reports no lifecycle or revision.
 */
const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ruling-lifecycle-cli-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  await handleTicketCreate(
    { title: "Cited ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    dir,
  );
  return dir;
}

async function ctxFor(root: string, format: "json" | "md" = "json"): Promise<CommandContext> {
  const { state } = await loadProject(root);
  return { state, warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

const CALLER = "test-session-1";
const BASE = { attribution: "owner-direct", date: "2026-09-21", scopeTags: ["logging"], clientTaskId: CALLER };

async function createR1(root: string): Promise<string> {
  const r = await handleRulingCreate({ ...BASE, text: "R1: redaction on every path" }, "json", root);
  return JSON.parse(r.output).data.id as string;
}

async function get(root: string, id: string) {
  return JSON.parse(handleRulingGet(id, await ctxFor(root)).output).data;
}

/**
 * Every ledger file under tickets/, issues/ and rulings/ with its bytes AND
 * its mtime, so "wrote nothing" means nothing: not a rewrite of identical
 * bytes, not a stray file, not a touched item.
 */
async function ledgerSnapshot(root: string): Promise<Map<string, { content: string; mtimeMs: number }>> {
  const out = new Map<string, { content: string; mtimeMs: number }>();
  for (const dir of ["tickets", "issues", "rulings"]) {
    const abs = join(root, ".story", dir);
    for (const name of (await readdir(abs)).sort()) {
      const file = join(abs, name);
      const st = await stat(file);
      if (!st.isFile()) continue;
      out.set(`${dir}/${name}`, { content: await readFile(file, "utf-8"), mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

async function expectLedgerUnchanged(root: string, before: Map<string, { content: string; mtimeMs: number }>): Promise<void> {
  expect(await ledgerSnapshot(root)).toEqual(before);
}

describe("create and supersede write acceptance evidence", () => {
  it("create records an ACCEPTED ruling with a matching digest and narrative", async () => {
    const root = await newProject();
    const r = await handleRulingCreate({ ...BASE, text: "R1", context: "why" }, "json", root);
    const data = JSON.parse(r.output).data;
    expect(data.status).toBe("accepted");
    expect(data.acceptance.payloadDigest).toBe(payloadDigest(data));
    expect(data.acceptance.recordedBy).toEqual({ client: "claude", id: CALLER });
    expect(data.narrative).toEqual({ context: "why" });
    const got = await get(root, data.id);
    expect(got.lifecycle).toBe("accepted");
    expect(got.revision).toBe(data.acceptance.payloadDigest);
  });

  it("create-and-supersede records an accepted successor whose edge is inside the accepted payload", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const r = await handleRulingSupersede(r1, { text: "R2", attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    const data = JSON.parse(r.output).data;
    expect(data.status).toBe("accepted");
    expect(data.supersedes).toBe(r1);
    expect(data.proposesToSupersede).toBe(r1);
    expect(data.acceptance.payloadDigest).toBe(payloadDigest(data));
    expect((await get(root, r1)).lifecycle).toBe("superseded");
    expect((await get(root, data.id)).lifecycle).toBe("accepted");
  });

  it("supersede --with on a 1.16 accepted record re-records acceptance for the linked payload; a proposal is refused (use accept)", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const other = JSON.parse((await handleRulingCreate({ ...BASE, text: "other", clientTaskId: "creator" }, "json", root)).output).data;
    const linked = JSON.parse((await handleRulingSupersede(r1, { withId: other.id, clientTaskId: CALLER }, "json", root)).output).data;
    expect(linked.supersedes).toBe(r1);
    expect(linked.proposesToSupersede).toBe(r1);
    expect(linked.acceptance.payloadDigest).toBe(payloadDigest(linked));
    expect(linked.acceptance.payloadDigest).not.toBe(other.acceptance.payloadDigest);
    expect(linked.acceptance.recordedBy).toEqual({ client: "claude", id: CALLER });
    expect(linked.acceptance.attribution).toBe(other.attribution);
    expect((await get(root, linked.id)).lifecycle).toBe("accepted");
    expect((await get(root, r1)).lifecycle).toBe("superseded");
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P" }, "json", root)).output).data.id;
    await expect(handleRulingSupersede(other.id, { withId: p, clientTaskId: CALLER }, "json", root)).rejects.toThrow(/instead of linking it/);
  });

  it("supersede --with still links a LEGACY (1.15) record in place", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const legacyId = "r-0123456789abcdef";
    await writeFile(join(root, ".story", "rulings", `${legacyId}.json`), JSON.stringify({
      id: legacyId, text: "legacy", attribution: "owner-direct", recordedBy: { client: "claude", id: "old" },
      date: "2026-01-01", scopeTags: [], supersedes: null,
    }));
    const r = await handleRulingSupersede(r1, { withId: legacyId, clientTaskId: CALLER }, "json", root);
    expect(JSON.parse(r.output).data.supersedes).toBe(r1);
    expect((await get(root, r1)).lifecycle).toBe("superseded");
  });
});

describe("propose", () => {
  it("writes one proposed record with no supersedes edge and no item writes; R1 stays current", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const before = await ledgerSnapshot(root);
    const r = await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1, proposedFor: ["T-001"], context: "ctx" }, "json", root);
    const data = JSON.parse(r.output).data;
    const after = await ledgerSnapshot(root);
    const added = [...after.keys()].filter((k) => !before.has(k));
    expect(added).toEqual([`rulings/${data.id}.json`]);
    for (const [k, v] of before) expect(after.get(k)).toEqual(v);
    expect(data.status).toBe("proposed");
    expect(data.supersedes).toBeNull();
    expect(data.proposesToSupersede).toBe(r1);
    expect(data.proposedFor).toEqual(["T-001"]);
    expect(data.revision).toBe(payloadDigest(data));
    expect(data.acceptance).toBeUndefined();
    const { state } = await loadProject(root);
    expect(state.tickets[0]!.citesRulings ?? []).toEqual([]);
    const r1View = await get(root, r1);
    expect(r1View.lifecycle).toBe("accepted");
    expect(r1View.chainStatus).toMatchObject({ status: "resolved", stale: false });
    expect(r1View.proposalsAgainst).toEqual([data.id]);
    const pView = await get(root, data.id);
    expect(pView.lifecycle).toBe("proposed");
    expect(pView.chainStatus.status).toBe("nonaccepted");
    expect(pView.chainStatus.warning).toContain("proposed and binds nothing");
  });

  it("a whitespace-padded proposedFor ref is trimmed before it is persisted, so accept resolves it", async () => {
    const root = await newProject();
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposedFor: [" T-001 ", "T-001"] }, "json", root)).output).data;
    expect(p.proposedFor).toEqual(["T-001"]);
    const a = JSON.parse((await handleRulingAccept(p.id, { revision: p.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root)).output).data;
    expect(a.status).toBe("accepted");
    const { state } = await loadProject(root);
    expect(state.tickets[0]!.citesRulings).toEqual([p.id]);
  });

  it("refuses a target that is itself proposed, withdrawn, or missing, and a dangling proposedFor item", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P" }, "json", root)).output).data.id;
    let before = await ledgerSnapshot(root);
    await expect(handleRulingPropose({ ...BASE, text: "Q", proposesToSupersede: p }, "json", root)).rejects.toThrow(/is proposed/);
    await expectLedgerUnchanged(root, before);
    await handleRulingWithdraw(p, { clientTaskId: CALLER }, "json", root);
    before = await ledgerSnapshot(root);
    await expect(handleRulingPropose({ ...BASE, text: "Q", proposesToSupersede: p }, "json", root)).rejects.toThrow(/is withdrawn/);
    await expect(handleRulingPropose({ ...BASE, text: "Q", proposesToSupersede: "r-0000000000000009" }, "json", root)).rejects.toThrow(/not found/);
    await expect(handleRulingPropose({ ...BASE, text: "Q", proposesToSupersede: r1, proposedFor: ["T-404"] }, "json", root)).rejects.toThrow(CliValidationError);
    await expectLedgerUnchanged(root, before);
  });

  it("the md `get` says it is a proposal and binds nothing", async () => {
    const root = await newProject();
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P" }, "json", root)).output).data.id;
    const md = handleRulingGet(p, await ctxFor(root, "md")).output;
    expect(md).toContain("[proposed]");
    expect(md).toContain("This is a PROPOSAL");
    expect(md).toContain("Revision: ");
  });
});

describe("accept", () => {
  it("copies the edge into supersedes, records acceptance, unions the citation onto proposedFor items; R1 resolves forward", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    // T-001 already cites another ruling: accept must UNION, not replace.
    const seed = JSON.parse((await handleRulingCreate({ ...BASE, text: "seed", cites: ["T-001"] }, "json", root)).output).data.id as string;
    expect((await loadProject(root)).state.tickets[0]!.citesRulings).toEqual([seed]);
    const proposed = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1, proposedFor: ["T-001"] }, "json", root)).output).data;
    const r = await handleRulingAccept(proposed.id, { revision: proposed.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    const data = JSON.parse(r.output).data;
    expect(data.noop).toBe(false);
    expect(data.status).toBe("accepted");
    expect(data.supersedes).toBe(r1);
    expect(data.acceptance).toMatchObject({ attribution: "owner-direct", recordedBy: { client: "claude", id: CALLER }, date: "2026-09-22", payloadDigest: proposed.revision });
    expect(data.text).toBe("P");
    const { state } = await loadProject(root);
    expect(state.tickets[0]!.citesRulings).toEqual([seed, proposed.id]);
    const r1View = await get(root, r1);
    expect(r1View.lifecycle).toBe("superseded");
    expect(r1View.chainStatus).toMatchObject({ status: "resolved", stale: true, current: { id: proposed.id } });
    expect(r1View.text).toBe("R1: redaction on every path");
  });

  it("a repeat with the same revision is a no-op success that writes nothing, even after a later supersede", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const proposed = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1, proposedFor: ["T-001"] }, "json", root)).output).data;
    const args = { revision: proposed.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER };
    await handleRulingAccept(proposed.id, args, "json", root);
    // A later successor: the record is now superseded, still accepted at its revision.
    await handleRulingSupersede(proposed.id, { text: "P2", attribution: "owner-direct", date: "2026-09-23", clientTaskId: CALLER }, "json", root);
    // Remove the citation by hand: a repeat must NOT put it back.
    const ticketFile = join(root, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(await readFile(ticketFile, "utf-8"));
    expect(ticket.citesRulings).toEqual([proposed.id]);
    delete ticket.citesRulings;
    await writeFile(ticketFile, JSON.stringify(ticket, null, 2) + "\n");
    const before = await ledgerSnapshot(root);
    const again = JSON.parse((await handleRulingAccept(proposed.id, args, "json", root)).output).data;
    expect(again.noop).toBe(true);
    await expectLedgerUnchanged(root, before);
    expect(JSON.parse(await readFile(ticketFile, "utf-8")).citesRulings).toBeUndefined();
  });

  it("refuses a stale revision (the text changed since review) and a record that is not a proposal", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const proposed = JSON.parse((await handleRulingPropose({ ...BASE, text: "P" }, "json", root)).output).data;
    const path = join(root, ".story", "rulings", `${proposed.id}.json`);
    const record = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({ ...record, text: "P edited" }));
    await expect(handleRulingAccept(proposed.id, { revision: proposed.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root))
      .rejects.toThrow(/changed since it was reviewed/);
    // R1 is accepted, so a repeat at ITS revision is the designed no-op; at
    // any other revision it is refused as not a proposal.
    await expect(handleRulingAccept(r1, { revision: "0".repeat(64), attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root))
      .rejects.toThrow(/not a proposal/);
    await expect(handleRulingAccept(proposed.id, { revision: "nope", attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root))
      .rejects.toThrow(/64-hex/);
  });

  it("two proposals against R1: the second accept is refused as a branch unless --branch", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1 }, "json", root)).output).data;
    const q = JSON.parse((await handleRulingPropose({ ...BASE, text: "Q", proposesToSupersede: r1 }, "json", root)).output).data;
    const args = { attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER };
    await handleRulingAccept(p.id, { ...args, revision: p.revision }, "json", root);
    await expect(handleRulingAccept(q.id, { ...args, revision: q.revision }, "json", root)).rejects.toThrow(/competing successors/);
    await handleRulingAccept(q.id, { ...args, revision: q.revision, branch: true }, "json", root);
    expect((await get(root, r1)).chainStatus).toMatchObject({ status: "branch" });
  });

  it("refuses while any ruling file is unreadable", async () => {
    const root = await newProject();
    await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P" }, "json", root)).output).data;
    await writeFile(join(root, ".story", "rulings", "r-0000000000000009.json"), "{ not json");
    await expect(handleRulingAccept(p.id, { revision: p.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root))
      .rejects.toThrow(/not fully readable/);
  });
});

describe("withdraw and list", () => {
  it("withdraw marks a proposal withdrawn with the caller and reason; refuses an accepted ruling", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1 }, "json", root)).output).data;
    const w = JSON.parse((await handleRulingWithdraw(p.id, { reason: "superseded by owner", clientTaskId: CALLER }, "json", root)).output).data;
    expect(w.status).toBe("withdrawn");
    expect(w.withdrawal).toMatchObject({ recordedBy: { client: "claude", id: CALLER }, reason: "superseded by owner" });
    expect((await get(root, p.id)).lifecycle).toBe("withdrawn");
    await expect(handleRulingWithdraw(r1, { clientTaskId: CALLER }, "json", root)).rejects.toThrow(/not a proposal/);
    await expect(handleRulingWithdraw(p.id, { clientTaskId: CALLER }, "json", root)).rejects.toThrow(/is withdrawn/);
  });

  it("list --status buckets by lifecycle and carries lifecycle in JSON", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1 }, "json", root)).output).data;
    const w = JSON.parse((await handleRulingPropose({ ...BASE, text: "W" }, "json", root)).output).data;
    await handleRulingWithdraw(w.id, { clientTaskId: CALLER }, "json", root);
    await handleRulingAccept(p.id, { revision: p.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    const ctx = await ctxFor(root);
    const ids = (status: string) => JSON.parse(handleRulingList({ status }, ctx).output).data.map((r: { id: string }) => r.id);
    expect(ids("accepted")).toEqual([p.id].sort());
    expect(ids("superseded")).toEqual([r1]);
    expect(ids("withdrawn")).toEqual([w.id]);
    expect(ids("proposed")).toEqual([]);
    expect(JSON.parse(handleRulingList({}, ctx).output).data.find((r: { id: string }) => r.id === r1).lifecycle).toBe("superseded");
    expect(() => handleRulingList({ status: "final" }, ctx)).toThrow(/Unknown status/);
  });

  it("list --status accepted includes a LEGACY (1.15) record: accepted by shape", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const legacyId = "r-0123456789abcdef";
    await writeFile(join(root, ".story", "rulings", `${legacyId}.json`), JSON.stringify({
      id: legacyId, text: "legacy", attribution: "owner-direct", recordedBy: { client: "claude", id: "old" },
      date: "2026-01-01", scopeTags: [], supersedes: null,
    }));
    const ctx = await ctxFor(root);
    const listed = JSON.parse(handleRulingList({ status: "accepted" }, ctx).output).data;
    expect(listed.map((r: { id: string }) => r.id).sort()).toEqual([legacyId, r1].sort());
    expect(listed.find((r: { id: string }) => r.id === legacyId).lifecycle).toBe("accepted-legacy");
  });

  it("list in Markdown is the Decisions listing: sections, verbatim fenced text, proposals against, cited by", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P *not* escaped", proposesToSupersede: r1, proposedFor: ["T-001"], context: "ctx" }, "json", root)).output).data;
    const md = handleRulingList({}, await ctxFor(root, "md")).output;
    expect(md).toContain("# Decisions");
    expect(md).toContain("## Accepted");
    expect(md).toContain("## Proposed (not binding)");
    expect(md.indexOf("## Accepted")).toBeLessThan(md.indexOf("## Proposed (not binding)"));
    expect(md).toContain("P *not* escaped");
    expect(md).toContain(`Proposals against this ruling (not binding): ${p.id}`);
    expect(md).toContain("Proposed for: T-001");
    expect(md).toContain("- context: ctx");
  });

  it("Decisions listing: caveat on every record, unverified supersedes is a claim, free-form fields stay literal", async () => {
    const root = await newProject();
    const r1 = await createR1(root);
    const scoped = JSON.parse((await handleRulingCreate({
      ...BASE, text: "S", scopeTags: ["<img src=x onerror=1>", "[link](http://x)"], context: "see `code` and <b>bold</b>", clientTaskId: CALLER,
    }, "json", root)).output).data;
    // A hand-edited record: claims accepted with an edge but carries no acceptance, so it is quarantined.
    const forged = "r-00000000000000ff";
    await writeFile(join(root, ".story", "rulings", `${forged}.json`), JSON.stringify({
      id: forged, text: "forged", attribution: "owner-direct", recordedBy: { client: "claude", id: "x" },
      date: "2026-01-01", scopeTags: [], supersedes: r1, status: "accepted", proposesToSupersede: r1,
    }));
    const hostile = "r-00000000000000fe";
    await writeFile(join(root, ".story", "rulings", `${hostile}.json`), JSON.stringify({
      id: hostile, text: "h", attribution: "owner-direct", recordedBy: { client: "claude", id: "x" },
      date: "2026-01-01", scopeTags: [], supersedes: null, status: "proposed", proposesToSupersede: null,
      proposedFor: ["<script>x</script>", "[T-001](http://evil)"],
    }));
    const md = handleRulingList({}, await ctxFor(root, "md")).output;
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("](http://evil)");
    expect(md).toContain("Proposed for: &lt;script&gt;x&lt;/script&gt;, \\[T-001\\]\\(http://evil\\)");
    const records = md.split("\n### ").length - 1;
    expect((md.match(/^> Attribution is a CLAIM/gm) ?? []).length).toBe(records);
    expect(md).toContain(`### ${forged} [quarantined]`);
    expect(md).toContain(`claims to supersede ${r1} (unverified)`);
    expect(md).not.toContain(`Chain: supersedes ${r1}`);
    expect(md).not.toContain("<img");
    expect(md).not.toContain("[link](");
    expect(md).not.toContain("<b>");
    expect(md).toContain("&lt;img");
    expect(md).toContain("- context: see \\`code\\` and &lt;b&gt;bold&lt;/b&gt;");
    expect(md).toContain(`### ${scoped.id} [accepted]`);
  });
});

describe("T-522 commit 3: team-mode precondition on every ruling write", () => {
  const saved = process.env.STORYBLOQ_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORYBLOQ_VERSION;
    else process.env.STORYBLOQ_VERSION = saved;
  });

  async function teamProject(fence: string): Promise<string> {
    const root = await newProject();
    const configPath = join(root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.team = { enabled: true, minCliVersion: fence, mergeDriverVersion: 1 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    return root;
  }

  it("refuses create, supersede, propose, accept and withdraw until team setup raised the fence and wrote the rulings attribute; reads are never refused", async () => {
    process.env.STORYBLOQ_VERSION = "1.16.0";
    const root = await teamProject("1.4.4");
    const refusal = /storybloq team setup/;
    await expect(handleRulingCreate({ ...BASE, text: "R1" }, "json", root)).rejects.toThrow(refusal);
    await expect(handleRulingPropose({ ...BASE, text: "P" }, "json", root)).rejects.toThrow(refusal);
    await expect(handleRulingSupersede("r-0000000000000001", { text: "x", attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root)).rejects.toThrow(refusal);
    await expect(handleRulingAccept("r-0000000000000001", { revision: "0".repeat(64), attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root)).rejects.toThrow(refusal);
    await expect(handleRulingWithdraw("r-0000000000000001", { clientTaskId: CALLER }, "json", root)).rejects.toThrow(refusal);
    expect(handleRulingList({}, await ctxFor(root)).output).toContain('"data": []');

    const { teamSetup } = await import("../../../src/core/team-setup.js");
    const setup = await teamSetup(root);
    expect(setup.rulingFence).toBe("raised");
    const r1 = await createR1(root);
    const p = JSON.parse((await handleRulingPropose({ ...BASE, text: "P", proposesToSupersede: r1 }, "json", root)).output).data;
    await handleRulingAccept(p.id, { revision: p.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    expect((await get(root, r1)).lifecycle).toBe("superseded");
  });

  it("a fence at 1.16.0 without the rulings attribute line is still refused, naming the missing line", async () => {
    process.env.STORYBLOQ_VERSION = "1.16.0";
    const root = await teamProject("1.16.0");
    await expect(handleRulingCreate({ ...BASE, text: "R1" }, "json", root)).rejects.toThrow(/rulings\/\*\.json merge=storybloq-json/);
  });

  it("a non-team project has no precondition", async () => {
    const root = await newProject();
    await expect(createR1(root)).resolves.toMatch(/^r-/);
  });
});
