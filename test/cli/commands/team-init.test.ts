import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { handleTeamInit } from "../../../src/cli/commands/team-init.js";
import { LOCAL_ALLOCATOR_NOTE } from "../../../src/core/team-setup.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-init-cli-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function writeProject(root: string, config: Record<string, unknown> = {}): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  for (const dir of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(storyDir, dir), { recursive: true });
  }
  writeFileSync(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2,
      project: "test",
      type: "npm",
      language: "ts",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      ...config,
    }, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
      blockers: [],
    }, null, 2) + "\n",
    "utf-8",
  );
}

// ISS-734: inline collision guidance. The local allocator's duplicate-displayId
// tradeoff must be surfaced where the choice is made, not only in the README.
describe("ISS-734: handleTeamInit allocator guidance", () => {
  it("prints the local-allocator note when the id allocator defaults to local", async () => {
    const root = createTempGitRepo();
    writeProject(root);
    const result = await handleTeamInit(root, { format: "md" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(LOCAL_ALLOCATOR_NOTE);
    expect(result.output).toContain("storybloq reconcile");
  });

  it("prints the note when --id-allocator local is explicit", async () => {
    const root = createTempGitRepo();
    writeProject(root);
    const result = await handleTeamInit(root, { idAllocator: "local", format: "md" });
    expect(result.output).toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("does NOT print the note when --id-allocator git-refs is chosen", async () => {
    const root = createTempGitRepo();
    writeProject(root);
    const result = await handleTeamInit(root, { idAllocator: "git-refs", format: "md" });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("does NOT print the note when the project already uses git-refs (re-run)", async () => {
    const root = createTempGitRepo();
    writeProject(root, { team: { enabled: true, idAllocator: "git-refs" } });
    // Re-running team init must respect the pre-existing allocator, not the
    // default: the note keys off the EFFECTIVE allocator, not the option.
    const result = await handleTeamInit(root, { format: "md" });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("includes the effective allocator and note in json output", async () => {
    const root = createTempGitRepo();
    writeProject(root);
    const result = await handleTeamInit(root, { format: "json" });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed.idAllocator).toBe("local");
    expect(parsed.note).toBe(LOCAL_ALLOCATOR_NOTE);
  });

  it("omits the note field from json output for git-refs", async () => {
    const root = createTempGitRepo();
    writeProject(root);
    const result = await handleTeamInit(root, { idAllocator: "git-refs", format: "json" });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed.idAllocator).toBe("git-refs");
    expect(parsed.note).toBeUndefined();
  });
});
