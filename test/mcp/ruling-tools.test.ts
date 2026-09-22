import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { loadRulingsSafe } from "../../src/core/ruling-loader.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ruling MCP tools (T-476)", () => {
  it("registers storybloq_ruling_get, _list, _create, and _supersede", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_ruling_get")).toBe(true);
    expect(tools.has("storybloq_ruling_list")).toBe(true);
    expect(tools.has("storybloq_ruling_create")).toBe(true);
    expect(tools.has("storybloq_ruling_supersede")).toBe(true);
  });

  it("create -> get round-trips through the registered handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Owner rules: duet mode is the name.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    expect(createResult.isError).toBeFalsy();
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), so the id is extracted from the sentence, not parsed as JSON.
    const createdMatch = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./);
    expect(createdMatch).not.toBeNull();
    const id = createdMatch![1]!;

    const getResult = await tools.get("storybloq_ruling_get")!.handler({ id });
    expect(getResult.isError).toBeFalsy();
    expect(getResult.content[0]!.text).toContain(id);
    expect(getResult.content[0]!.text).toContain("Owner rules: duet mode is the name.");
    // The anti-laundering caveat renders unconditionally.
    expect(getResult.content[0]!.text).toContain("not verified by storybloq");
  });

  it("create rejects an unknown attribution value", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const result = await tools.get("storybloq_ruling_create")!.handler({
      text: "text",
      attribution: "owner-implied",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });

  it("list surfaces created rulings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "First ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const id = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;
    const listResult = await tools.get("storybloq_ruling_list")!.handler({});
    expect(listResult.isError).toBeFalsy();
    expect(listResult.content[0]!.text).toContain(id);
  });

  it("supersede create-and-supersede mode links the new ruling to the old one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Old ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const oldId = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const supersedeResult = await tools.get("storybloq_ruling_supersede")!.handler({
      id: oldId,
      text: "New ruling.",
      attribution: "manager-delegated",
      date: "2026-08-28",
      clientTaskId: "mcp-test-session",
    });
    expect(supersedeResult.isError).toBeFalsy();
    expect(supersedeResult.content[0]!.text).toContain(`now supersedes ${oldId}`);
  });

  it("storybloq_ticket_create/_update wire citesRuling and clearCitesRulings (section 10)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);

    const rulingResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "cited by a ticket", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    });
    const rulingId = rulingResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const createResult = await tools.get("storybloq_ticket_create")!.handler({
      title: "t", type: "task", citesRuling: [rulingId],
    });
    expect(createResult.isError).toBeFalsy();
    const ticketId = createResult.content[0]!.text.match(/Created ticket (T-\d+)/)![1]!;

    const getResult = await tools.get("storybloq_ticket_get")!.handler({ id: ticketId });
    expect(getResult.content[0]!.text).toContain("cited by a ticket");

    const clearResult = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, clearCitesRulings: true,
    });
    expect(clearResult.isError).toBeFalsy();
    const afterClear = await tools.get("storybloq_ticket_get")!.handler({ id: ticketId });
    expect(afterClear.content[0]!.text).not.toContain("cited by a ticket");

    const conflict = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [rulingId], clearCitesRulings: true,
    });
    expect(conflict.isError).toBe(true);

    // Boundary cases the CLI has no equivalent path for: an empty array must
    // not become a silent, clearCitesRulings-free way to clear (or to sneak
    // past the mutex check by being "technically empty").
    const emptyPlusClear = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [], clearCitesRulings: true,
    });
    expect(emptyPlusClear.isError).toBe(true);

    const emptyAlone = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [],
    });
    expect(emptyAlone.isError).toBe(true);
  });

  it("supersede refuses `with` combined with create-only fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const a = (await tools.get("storybloq_ruling_create")!.handler({
      text: "a", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    })).content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;
    const b = (await tools.get("storybloq_ruling_create")!.handler({
      text: "b", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    })).content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const result = await tools.get("storybloq_ruling_supersede")!.handler({
      id: a, with: b, text: "should not be accepted alongside with", clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });

  it("supersede refuses a self-link", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Only ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const id = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const result = await tools.get("storybloq_ruling_supersede")!.handler({
      id,
      with: id,
      clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });
});

// T-522 commit 2b: the proposal lifecycle reaches MCP. RED at 89e2f6fa: the
// three tools are not registered and `status` is not a list parameter.
describe("ruling lifecycle MCP tools (T-522)", () => {
  async function project(): Promise<{ root: string; tools: Map<string, RegisteredTool> }> {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-lc-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate({ title: "Cited", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
    return { root, tools: captureTools(root) };
  }

  it("registers propose, accept and withdraw, and status on list", async () => {
    const { tools } = await project();
    for (const name of ["storybloq_ruling_propose", "storybloq_ruling_accept", "storybloq_ruling_withdraw"]) expect(tools.has(name), name).toBe(true);
    const keysOf = (schema: unknown): string[] => Object.keys(((schema as { shape?: Record<string, unknown> }).shape ?? schema) as object);
    expect(keysOf(tools.get("storybloq_ruling_list")!.config.inputSchema)).toContain("status");
    const supersedeKeys = keysOf(tools.get("storybloq_ruling_supersede")!.config.inputSchema);
    for (const key of ["branch", "context", "alternatives", "consequences", "reconsiderWhen"]) expect(supersedeKeys, key).toContain(key);
  });

  it("propose binds nothing, accept with the reviewed revision cites the item, withdraw retires a proposal", async () => {
    const { root, tools } = await project();
    const proposed = await tools.get("storybloq_ruling_propose")!.handler({
      text: "Proposed: every path redacts.", attribution: "owner-direct", date: "2026-09-22",
      proposedFor: ["T-001"], context: "Logging leaked ids.", clientTaskId: "mcp-test-session",
    });
    expect(proposed.isError, proposed.content[0]!.text).toBeFalsy();
    const m = /Proposed ruling (r-[0-9a-z]+) \(revision ([0-9a-f]{64})\)/.exec(proposed.content[0]!.text);
    expect(m).not.toBeNull();
    const [, id, revision] = m!;
    expect(proposed.content[0]!.text).toContain("A proposal binds nothing");
    let loaded = loadRulingsSafe(root);
    expect(loaded.lifecycleById.get(id!)).toBe("proposed");
    expect(loaded.rulings.find((r) => r.id === id)!.narrative?.context).toBe("Logging leaked ids.");
    // every narrative field reaches the record through propose and through supersede (Codex 4a minor)
    const full = await tools.get("storybloq_ruling_propose")!.handler({
      text: "Full narrative.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session",
      context: "c1", alternatives: "a1", consequences: "q1", reconsiderWhen: "w1",
    });
    const fullId = /Proposed ruling (r-[0-9a-z]+)/.exec(full.content[0]!.text)![1]!;
    expect(loadRulingsSafe(root).rulings.find((r) => r.id === fullId)!.narrative).toEqual({ context: "c1", alternatives: "a1", consequences: "q1", reconsiderWhen: "w1" });
    const base = await tools.get("storybloq_ruling_create")!.handler({ text: "Base.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    const baseId = /Created ruling (r-[0-9a-z]+)\./.exec(base.content[0]!.text)![1]!;
    const sup = await tools.get("storybloq_ruling_supersede")!.handler({
      id: baseId, text: "Successor.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session",
      context: "c2", alternatives: "a2", consequences: "q2", reconsiderWhen: "w2",
    });
    expect(sup.isError, sup.content[0]!.text).toBeFalsy();
    const supRec = loadRulingsSafe(root).rulings.find((r) => r.supersedes === baseId)!;
    expect(supRec.narrative).toEqual({ context: "c2", alternatives: "a2", consequences: "q2", reconsiderWhen: "w2" });
    // the item has no citation yet
    const ticketBefore = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(ticketBefore.citesRulings ?? []).toEqual([]);
    // a wrong revision is refused, the right one accepts and cites
    const wrong = await tools.get("storybloq_ruling_accept")!.handler({ id, revision: "0".repeat(64), attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    expect(wrong.isError).toBe(true);
    const accepted = await tools.get("storybloq_ruling_accept")!.handler({ id, revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    expect(accepted.isError, accepted.content[0]!.text).toBeFalsy();
    loaded = loadRulingsSafe(root);
    expect(loaded.lifecycleById.get(id!)).toBe("accepted");
    const ticketAfter = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(ticketAfter.citesRulings).toEqual([id]);
    // withdraw: a second proposal goes, the accepted one is refused
    const second = await tools.get("storybloq_ruling_propose")!.handler({ text: "Second.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    const id2 = /Proposed ruling (r-[0-9a-z]+)/.exec(second.content[0]!.text)![1]!;
    // list status reaches the handler: each bucket holds its own record and not the other's
    const acceptedList = (await tools.get("storybloq_ruling_list")!.handler({ status: "accepted" })).content[0]!.text;
    expect(acceptedList).toContain(id!);
    expect(acceptedList).not.toContain(id2);
    const proposedList = (await tools.get("storybloq_ruling_list")!.handler({ status: "proposed" })).content[0]!.text;
    expect(proposedList).toContain(id2);
    expect(proposedList).not.toContain(id!);
    const withdrawn = await tools.get("storybloq_ruling_withdraw")!.handler({ id: id2, reason: "superseded by discussion", clientTaskId: "mcp-test-session" });
    expect(withdrawn.isError, withdrawn.content[0]!.text).toBeFalsy();
    expect(withdrawn.content[0]!.text).toContain(`Withdrew proposal ${id2}`);
    expect(loadRulingsSafe(root).lifecycleById.get(id2)).toBe("withdrawn");
    const refused = await tools.get("storybloq_ruling_withdraw")!.handler({ id, clientTaskId: "mcp-test-session" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("not a proposal");
  });

  it("branch reaches supersede and accept: a second successor is refused without it and recorded with it", async () => {
    const { tools } = await project();
    const created = await tools.get("storybloq_ruling_create")!.handler({ text: "R1.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    const r1 = /Created ruling (r-[0-9a-z]+)\./.exec(created.content[0]!.text)![1]!;
    const first = await tools.get("storybloq_ruling_supersede")!.handler({ id: r1, text: "R2.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    expect(first.isError, first.content[0]!.text).toBeFalsy();
    const refused = await tools.get("storybloq_ruling_supersede")!.handler({ id: r1, text: "R3.", attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    expect(refused.isError).toBe(true);
    const branched = await tools.get("storybloq_ruling_supersede")!.handler({ id: r1, text: "R3.", attribution: "owner-direct", date: "2026-09-22", branch: true, clientTaskId: "mcp-test-session" });
    expect(branched.isError, branched.content[0]!.text).toBeFalsy();
    // accept: a proposal against a node that already has a successor needs branch too
    const proposed = await tools.get("storybloq_ruling_propose")!.handler({ text: "R4 proposed.", attribution: "owner-direct", date: "2026-09-22", proposesToSupersede: r1, clientTaskId: "mcp-test-session" });
    const m = /Proposed ruling (r-[0-9a-z]+) \(revision ([0-9a-f]{64})\)/.exec(proposed.content[0]!.text);
    expect(m, proposed.content[0]!.text).not.toBeNull();
    const acceptRefused = await tools.get("storybloq_ruling_accept")!.handler({ id: m![1]!, revision: m![2]!, attribution: "owner-direct", date: "2026-09-22", clientTaskId: "mcp-test-session" });
    expect(acceptRefused.isError).toBe(true);
    const acceptBranched = await tools.get("storybloq_ruling_accept")!.handler({ id: m![1]!, revision: m![2]!, attribution: "owner-direct", date: "2026-09-22", branch: true, clientTaskId: "mcp-test-session" });
    expect(acceptBranched.isError, acceptBranched.content[0]!.text).toBeFalsy();
  });
});

