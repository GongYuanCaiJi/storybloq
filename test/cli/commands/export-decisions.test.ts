import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExport } from "../../../src/cli/commands/export.js";
import { handleRulingCreate, handleRulingSupersede, handleRulingPropose } from "../../../src/cli/commands/ruling.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import type { CommandContext } from "../../../src/cli/types.js";
import { generateCanonicalId } from "../../../src/core/canonical-id.js";

/**
 * T-522 plan section 6: the Decisions section of `export`. RED at 89e2f6fa:
 * handleExport renders no Decisions section in either mode.
 */
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const CALLER = "export-decisions-test";
const BASE = { attribution: "owner-direct", date: "2026-09-22", scopeTags: [] as string[], clientTaskId: CALLER };

async function ctxFor(root: string, format: "md" | "json"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

async function project(): Promise<{ root: string; r1: string; r2: string; r3: string; r4: string }> {
  const root = await mkdtemp(join(tmpdir(), "export-decisions-"));
  dirs.push(root);
  await initProject(root, { name: "test" });
  await handleTicketCreate({ title: "Cited", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
  const r1 = JSON.parse((await handleRulingCreate({ ...BASE, text: "R1 text", cites: ["T-001"] }, "json", root)).output).data.id as string;
  const r2 = JSON.parse((await handleRulingSupersede(r1, { ...BASE, text: "R2 text", context: "R1 was too narrow." }, "json", root)).output).data.id as string;
  const r3 = JSON.parse((await handleRulingPropose({ ...BASE, text: "R3 proposed", proposedFor: ["T-001"] }, "json", root)).output).data.id as string;
  const r4 = JSON.parse((await handleRulingCreate({ ...BASE, text: "R4 unrelated" }, "json", root)).output).data.id as string;
  return { root, r1, r2, r3, r4 };
}

describe("export: the Decisions section (T-522 section 6)", () => {
  it("--all renders every record under its lifecycle, verbatim text fenced, narrative labelled", async () => {
    const { root, r1, r2, r3, r4 } = await project();
    const md = handleExport(await ctxFor(root, "md"), "all", null).output;
    const at = md.indexOf("## Decisions (4)");
    expect(at).toBeGreaterThan(md.indexOf("## Glossary"));
    for (const id of [r1, r2, r3, r4]) expect(md.indexOf(`### ${id}`)).toBeGreaterThan(at);
    expect(md).toContain(`### ${r1} [superseded]`);
    expect(md).toContain(`### ${r3} [proposed]`);
    expect(md.indexOf(`### ${r3} [proposed]`)).toBeGreaterThan(md.indexOf("## Proposed (not binding)"));
    // verbatim text inside its fence, narrative under its commentary label, never inside the quote
    expect(md).toContain("```\nR1 text\n```");
    expect(md).toContain("```\nR2 text\n```");
    expect(md).toMatch(/\(commentary, not the decision\):\n[^\n]*R1 was too narrow\./);
    expect(md).not.toContain("```\nR2 text\nR1 was too narrow.");
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "all", null).output);
    expect(json.data.decisions.rulings.map((r: { id: string }) => r.id).sort()).toEqual([r1, r2, r3, r4].sort());
    expect(json.data.decisions.rulings.find((r: { id: string }) => r.id === r1).lifecycle).toBe("superseded");
    expect(json.data.decisions.warnings).toEqual([]);
  });

  it("a phase export keeps the cited record, its chain through the effective successor and the phase's proposals, and drops the rest", async () => {
    // T-001 cites only the superseded R1: R1 and R2 both export, R2 as the effective one; R3 is proposed for T-001; R4 is nobody's.
    const { root, r1, r2, r3, r4 } = await project();
    const md = handleExport(await ctxFor(root, "md"), "phase", "p0").output;
    expect(md).toContain("## Decisions (3, cited by this phase)");
    expect(md).toContain(`### ${r1} [superseded]`);
    expect(md).toContain(`### ${r2} [accepted]`);
    expect(md).toContain(`### ${r3} [proposed]`);
    expect(md).not.toContain(r4);
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "phase", "p0").output);
    expect(json.data.decisions.rulings.map((r: { id: string }) => r.id).sort()).toEqual([r1, r2, r3].sort());
    expect(json.data.decisions.diagnostics).toEqual([]);
  });

  // Mutant M5 (2026-09-22) survived without this: issues were selected by phase for tickets only.
  it("issues are selected by phase too: an issue in another phase citing R4 does not bring R4 into p0, an issue in p0 does", async () => {
    const { root, r4 } = await project();
    const created = await handleIssueCreate({ title: "Elsewhere", severity: "low", impact: "x", location: [], components: [], relatedTickets: [] }, "json", root);
    const issId = JSON.parse(created.output).data.id as string;
    const issPath = join(root, ".story", "issues", `${issId}.json`);
    const iss = JSON.parse(await readFile(issPath, "utf-8"));
    await writeFile(issPath, JSON.stringify({ ...iss, phase: "p9", citesRulings: [r4] }, null, 2));
    expect(handleExport(await ctxFor(root, "md"), "phase", "p0").output).not.toContain(r4);
    expect(handleExport(await ctxFor(root, "md"), "all", null).output).toContain(`### ${r4} `);
    await writeFile(issPath, JSON.stringify({ ...iss, phase: "p0", citesRulings: [r4] }, null, 2));
    expect(handleExport(await ctxFor(root, "md"), "phase", "p0").output).toContain(`### ${r4} [accepted]`);
  });

  it("a citation that cannot resolve is named in the section, never silently dropped", async () => {
    const { root, r2 } = await project();
    const path = join(root, ".story", "tickets", "T-001.json");
    const t = JSON.parse(await readFile(path, "utf-8"));
    // a second phase item citing the same missing id, and a second missing id on the first: one diagnostic per item per citation
    await handleTicketCreate({ title: "Second", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
    const path2 = join(root, ".story", "tickets", "T-002.json");
    await writeFile(path2, JSON.stringify({ ...JSON.parse(await readFile(path2, "utf-8")), citesRulings: ["r-0000000000000000"] }, null, 2));
    await writeFile(path, JSON.stringify({ ...t, citesRulings: [...t.citesRulings, "r-0000000000000000", "r-1111111111111111"] }, null, 2));
    const md = handleExport(await ctxFor(root, "md"), "phase", "p0").output;
    expect(md).toContain("_Citation: T-001 cites r-0000000000000000: no such ruling_");
    expect(md).toContain("_Citation: T-001 cites r-1111111111111111: no such ruling_");
    expect(md).toContain("_Citation: T-002 cites r-0000000000000000: no such ruling_");
    expect(md).toContain(`### ${r2} [accepted]`);
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "phase", "p0").output);
    expect(json.data.decisions.diagnostics).toEqual([
      "T-001 cites r-0000000000000000: no such ruling",
      "T-001 cites r-1111111111111111: no such ruling",
      "T-002 cites r-0000000000000000: no such ruling",
    ]);
  });

  // Codex (2026-09-22) finding: the known prefix of a chain must survive an
  // indeterminate resolution. R1 -> R2 accepted; R5 claims to supersede R2 but
  // its acceptance digest does not match its payload, so it is quarantined and
  // its edge is uncertain: the phase export keeps R1, R2 AND R5, with the
  // diagnostic, instead of R1 and R5 alone.
  it("an uncertain successor after an intermediate keeps the whole known prefix", async () => {
    const { root, r1, r2, r3 } = await project();
    const r2Rec = JSON.parse(await readFile(join(root, ".story", "rulings", `${r2}.json`), "utf-8"));
    const r5 = generateCanonicalId("r");
    await writeFile(join(root, ".story", "rulings", `${r5}.json`), JSON.stringify({ ...r2Rec, id: r5, supersedes: r2, text: "R5 edited after acceptance" }, null, 2));
    const md = handleExport(await ctxFor(root, "md"), "phase", "p0").output;
    for (const id of [r1, r2, r3, r5]) expect(md, id).toContain(`### ${id} `);
    expect(md).toContain(`### ${r5} [quarantined]`);
    expect(md).toMatch(/_Citation: T-001 cites .*indeterminate/);
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "phase", "p0").output);
    expect(json.data.decisions.rulings.map((r: { id: string }) => r.id).sort()).toEqual([r1, r2, r3, r5].sort());
  });

  it("an unrelated unreadable ruling does not drop a citation's known successors from a phase export", async () => {
    const { root, r1, r2, r3, r4 } = await project();
    await writeFile(join(root, ".story", "rulings", `${r4}.json`), "{ not json");
    const md = handleExport(await ctxFor(root, "md"), "phase", "p0").output;
    expect(md).toContain(`### ${r1} [superseded]`);
    expect(md).toContain(`### ${r2} [accepted]`);
    expect(md).toContain(`### ${r3} [proposed]`);
    expect(md).toMatch(/_Ruling scan: /);
  });

  it("an unreadable ruling file is reported in the section header", async () => {
    const { root, r4 } = await project();
    await writeFile(join(root, ".story", "rulings", `${r4}.json`), "{ not json");
    const md = handleExport(await ctxFor(root, "md"), "all", null).output;
    const header = md.slice(md.indexOf("## Decisions (3)"), md.indexOf("## Accepted", md.indexOf("## Decisions (3)")));
    expect(header).toMatch(new RegExp(`_Ruling scan: [^\n]*${r4}\\.json[^\n]*_`));
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "all", null).output);
    expect(json.data.decisions.warnings.some((w: string) => w.includes(`${r4}.json`))).toBe(true);
  });

  // Codex 4b minor: the walk must follow EVERY edge, known and uncertain, from
  // every node it reaches. R1 has two accepted successors (R2, and R6 by
  // --branch); R5 is quarantined on R2 (uncertain edge); R8 is accepted on R5,
  // whose target is not accepted, so that edge is uncertain too. All of them
  // export for an item citing R1; R4 (nobody's) does not.
  it("a branching chain with uncertain edges exports every reachable record and nothing else", async () => {
    const { root, r1, r2, r3, r4 } = await project();
    const r6 = JSON.parse((await handleRulingSupersede(r1, { ...BASE, text: "R6 competing", branch: true }, "json", root)).output).data.id as string;
    const r2Rec = JSON.parse(await readFile(join(root, ".story", "rulings", `${r2}.json`), "utf-8"));
    const r5 = generateCanonicalId("r");
    await writeFile(join(root, ".story", "rulings", `${r5}.json`), JSON.stringify({ ...r2Rec, id: r5, supersedes: r2, text: "R5 edited after acceptance" }, null, 2));
    const r8 = JSON.parse((await handleRulingCreate({ ...BASE, text: "R8 on R5" }, "json", root)).output).data.id as string;
    const r8Path = join(root, ".story", "rulings", `${r8}.json`);
    await writeFile(r8Path, JSON.stringify({ ...JSON.parse(await readFile(r8Path, "utf-8")), supersedes: r5 }, null, 2));
    const json = JSON.parse(handleExport(await ctxFor(root, "json"), "phase", "p0").output);
    expect(json.data.decisions.rulings.map((r: { id: string }) => r.id).sort()).toEqual([r1, r2, r3, r5, r6, r8].sort());
    const md = handleExport(await ctxFor(root, "md"), "phase", "p0").output;
    for (const id of [r1, r2, r3, r5, r6, r8]) expect(md, id).toContain(`### ${id} `);
    expect(md).not.toContain(r4);
  });
});
