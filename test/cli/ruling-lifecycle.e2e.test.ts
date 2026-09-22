import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

/**
 * T-522 commit 2b: the ruling lifecycle through the BUILT CLI. The handlers
 * are unit-tested in commands/ruling-lifecycle.test.ts; this file pins the
 * yargs REGISTRATIONS in src/cli/register.ts, which those tests bypass: every
 * flag named here must reach its handler argument. RED at 89e2f6fa: `ruling
 * propose|accept|withdraw` are unknown commands and `list --status` is an
 * unknown argument.
 */
vi.setConfig({ testTimeout: 30_000 });

let fixture: E2ECliFixture;
beforeAll(async () => { fixture = await E2ECliFixture.create(); });
afterAll(async () => { await fixture.cleanup(); });

function run(cwd: string, ...args: string[]): { code: number; out: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { code: result.status ?? 1, out: result.stdout };
}

function rulings(dir: string): Record<string, unknown>[] {
  const d = join(dir, ".story", "rulings");
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf-8")) as Record<string, unknown>);
}

const ID = ["--client-task-id", "e2e-ruling-session"];
const WHO = ["--attribution", "owner-direct", "--date", "2026-09-22"];

describe("ruling lifecycle registrations (T-522 commit 2b)", () => {
  it("propose carries narrative, --for and --proposes-to-supersede; accept takes --revision and --branch; withdraw takes --reason; list takes --status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ruling-e2e-"));
    expect(run(dir, "init", "--name", "e2e").code).toBe(0);
    expect(run(dir, "ticket", "create", "--title", "t", "--type", "task").code).toBe(0);
    // an accepted R1 with narrative through create
    const r1 = run(dir, "ruling", "create", "--text", "R1", ...WHO, ...ID, "--context", "why R1", "--reconsider-when", "never", "--format", "json");
    expect(r1.code, r1.out).toBe(0);
    const r1Id = JSON.parse(r1.out).data.id as string;
    const r1Rec = rulings(dir).find((r) => r.id === r1Id)!;
    expect(r1Rec.narrative).toEqual({ context: "why R1", reconsiderWhen: "never" });
    // propose against R1, for T-001, with narrative
    const p = run(dir, "ruling", "propose", "--text", "P", ...WHO, ...ID, "--for", "T-001", "--proposes-to-supersede", r1Id, "--alternatives", "none", "--consequences", "some", "--format", "json");
    expect(p.code, p.out).toBe(0);
    const pData = JSON.parse(p.out).data as { id: string; revision: string; proposedFor: string[]; proposesToSupersede: string; narrative: unknown };
    expect(pData.proposedFor).toEqual(["T-001"]);
    expect(pData.proposesToSupersede).toBe(r1Id);
    expect(pData.narrative).toEqual({ alternatives: "none", consequences: "some" });
    // list --status reaches the handler
    const proposed = JSON.parse(run(dir, "ruling", "list", "--status", "proposed", "--format", "json").out).data as { id: string }[];
    expect(proposed.map((r) => r.id)).toEqual([pData.id]);
    const bad = run(dir, "ruling", "list", "--status", "bogus", "--format", "json");
    expect(bad.code).not.toBe(0);
    // withdraw --reason
    const w = run(dir, "ruling", "withdraw", pData.id, "--reason", "changed mind", ...ID, "--format", "json");
    expect(w.code, w.out).toBe(0);
    const withdrawn = rulings(dir).find((r) => r.id === pData.id) as { status: string; withdrawal?: { reason?: string } };
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawal?.reason).toBe("changed mind");
    // a second proposal, accepted with its revision; the ticket gains the citation
    const p2 = run(dir, "ruling", "propose", "--text", "P2", ...WHO, ...ID, "--for", "T-001", "--format", "json");
    const p2Data = JSON.parse(p2.out).data as { id: string; revision: string };
    const wrong = run(dir, "ruling", "accept", p2Data.id, "--revision", "0".repeat(64), ...WHO, ...ID, "--format", "json");
    expect(wrong.code).not.toBe(0);
    const a = run(dir, "ruling", "accept", p2Data.id, "--revision", p2Data.revision, ...WHO, ...ID, "--format", "json");
    expect(a.code, a.out).toBe(0);
    const t = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8")) as { citesRulings?: string[] };
    expect(t.citesRulings).toEqual([p2Data.id]);
    // --branch on supersede and accept: refused without, recorded with
    const s1 = run(dir, "ruling", "supersede", r1Id, "--text", "R2", ...WHO, ...ID, "--format", "json");
    expect(s1.code, s1.out).toBe(0);
    const s2 = run(dir, "ruling", "supersede", r1Id, "--text", "R3", ...WHO, ...ID, "--format", "json");
    expect(s2.code).not.toBe(0);
    const s3 = run(dir, "ruling", "supersede", r1Id, "--text", "R3", ...WHO, ...ID, "--branch", "--format", "json");
    expect(s3.code, s3.out).toBe(0);
    const p3 = run(dir, "ruling", "propose", "--text", "P3", ...WHO, ...ID, "--proposes-to-supersede", r1Id, "--format", "json");
    const p3Data = JSON.parse(p3.out).data as { id: string; revision: string };
    const a2 = run(dir, "ruling", "accept", p3Data.id, "--revision", p3Data.revision, ...WHO, ...ID, "--format", "json");
    expect(a2.code).not.toBe(0);
    const a3 = run(dir, "ruling", "accept", p3Data.id, "--revision", p3Data.revision, ...WHO, ...ID, "--branch", "--format", "json");
    expect(a3.code, a3.out).toBe(0);
    // supersede narrative reaches the record
    const s3Id = JSON.parse(s3.out).data.id as string;
    const s4 = run(dir, "ruling", "supersede", s3Id, "--text", "R4", ...WHO, ...ID, "--context", "ctx4", "--format", "json");
    expect(s4.code, s4.out).toBe(0);
    expect((rulings(dir).find((r) => r.id === JSON.parse(s4.out).data.id) as { narrative?: unknown }).narrative).toEqual({ context: "ctx4" });
  });
});
