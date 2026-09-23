/**
 * T-526 (plan D4): the three restore commands. CLI-only; each is a thin
 * handler over `restoreRecord`, so these pin the surface: the success
 * envelope, the `restore_unsafe` error, the input errors, and the reference.
 *
 * Standalone temp repositories only (ISS-1220).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleCapabilityRestore } from "../../../src/cli/commands/capability.js";
import { handleTermRestore } from "../../../src/cli/commands/term.js";
import { handleLedgerRestore } from "../../../src/cli/commands/ledger.js";
import { COMMANDS, MCP_TOOLS } from "../../../src/cli/commands/reference.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { initProject } from "../../../src/core/init.js";
import { ERROR_CODES } from "../../../src/models/types.js";
import { CapabilitySchema } from "../../../src/models/capability.js";
import { TermSchema } from "../../../src/models/glossary.js";

const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" });
}
async function newProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "restore-cli-"));
  roots.push(root);
  await initProject(root, { name: "Restore", type: "npm" });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  return root;
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
function doc(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
const cap = (summary: string) =>
  CapabilitySchema.parse({
    id: "cap-core",
    name: "Core",
    summary,
    entryPoints: ["src"],
    contract: "Does the core thing.",
    checkedAt: { sha: "0".repeat(40), date: "2026-09-20" },
  });
const term = (definition: string) => TermSchema.parse({ id: "term-duet", term: "duet", definition, updatedAt: "2026-09-20T00:00:00.000Z" });
const NOTE = ".story/notes/N-001.json";
const note = (content: string) =>
  doc({ id: "N-001", title: null, content, tags: [], status: "active", createdDate: "2026-09-20", updatedDate: "2026-09-20", updatedAt: "2026-09-20T00:00:00.000Z" });

describe("capability restore", () => {
  it("json success is an envelope carrying {outcome, target}, exit 0", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [cap("Before.")] }));
    const base = commit(root, "base");
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [cap("After.")] }));
    const head = commit(root, "edit");

    const result = await handleCapabilityRestore({ id: "cap-core", from: base, expect: head }, "json", root);
    expect(result.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(JSON.parse(result.output).data).toEqual({ outcome: "restored", target: "capability cap-core" });
    expect(readFileSync(join(root, ".story/capabilities.json"), "utf-8")).toBe(doc({ version: 1, capabilities: [cap("Before.")] }));

    const again = await handleCapabilityRestore({ id: "cap-core", from: base, expect: base }, "md", root);
    expect(again.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(again.output).toMatch(/unchanged/);
  });

  it("a refusal is error code restore_unsafe with the fixed-order message", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [cap("Before.")] }));
    const base = commit(root, "base");
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [cap("After.")] }));
    commit(root, "edit");

    // --expect names the base, but the entry has moved since: a mismatch.
    const result = await handleCapabilityRestore({ id: "cap-core", from: base, expect: base }, "json", root);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.errorCode).toBe("restore_unsafe");
    const body = JSON.parse(result.output);
    expect(body.error.code).toBe("restore_unsafe");
    expect(body.error.message).toMatch(/^restore-unsafe: capability cap-core: expect-mismatch \(-\)/);
  });

  it("an unresolvable oid is invalid_input", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [cap("Before.")] }));
    const base = commit(root, "base");
    const err = await handleCapabilityRestore({ id: "cap-core", from: "f".repeat(40), expect: base }, "json", root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as CliValidationError).code).toBe("invalid_input");
  });
});

describe("term restore", () => {
  it("restores one term", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", doc({ version: 1, terms: [term("Two sessions.")] }));
    const base = commit(root, "base");
    write(root, ".story/glossary.json", doc({ version: 1, terms: [term("Two sessions, one pen.")] }));
    const head = commit(root, "edit");
    const result = await handleTermRestore({ id: "term-duet", from: base, expect: head }, "md", root);
    expect(result.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(result.output).toMatch(/Restored term term-duet/);
    expect(readFileSync(join(root, ".story/glossary.json"), "utf-8")).toBe(doc({ version: 1, terms: [term("Two sessions.")] }));
  });

  it("refuses a term absent at --from with restore_unsafe", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", doc({ version: 1, terms: [] }));
    const base = commit(root, "base");
    write(root, ".story/glossary.json", doc({ version: 1, terms: [term("Two sessions.")] }));
    const head = commit(root, "added");
    const result = await handleTermRestore({ id: "term-duet", from: base, expect: head }, "md", root);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.errorCode).toBe("restore_unsafe");
    expect(result.output).toMatch(/absent-source/);
  });
});

describe("ledger restore", () => {
  it("restores a legacy-named note", async () => {
    const root = await newProject();
    write(root, NOTE, note("First."));
    const base = commit(root, "base");
    write(root, NOTE, note("Second."));
    const head = commit(root, "edit");
    const result = await handleLedgerRestore({ path: NOTE, from: base, expect: head }, "json", root);
    expect(JSON.parse(result.output).data).toEqual({ outcome: "restored", target: NOTE });
    expect(readFileSync(join(root, NOTE), "utf-8")).toBe(note("First."));
  });

  it("a ticket path is invalid_input", async () => {
    const root = await newProject();
    write(root, "README.md", "x\n");
    const base = commit(root, "base");
    const err = await handleLedgerRestore({ path: ".story/tickets/T-001.json", from: base, expect: base }, "md", root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as CliValidationError).code).toBe("invalid_input");
  });
});

describe("the restore surface", () => {
  it("restore_unsafe is a registered error code", () => {
    expect(ERROR_CODES).toContain("restore_unsafe");
  });

  it("all three commands are in the reference, and none is an MCP tool", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const name of ["capability restore", "term restore", "ledger restore"]) expect(names).toContain(name);
    const usage = COMMANDS.find((c) => c.name === "ledger restore")!.usage;
    expect(usage).toContain("--from <oid>");
    expect(usage).toContain("--expect <oid>");
    expect(MCP_TOOLS.some((t) => /restore/.test(t.name))).toBe(false);
  });
});
