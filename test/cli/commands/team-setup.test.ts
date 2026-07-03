import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { handleTeamSetup } from "../../../src/cli/commands/team-setup.js";
import { LOCAL_ALLOCATOR_NOTE } from "../../../src/core/team-setup.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-setup-cli-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function writeConfig(root: string, config: Record<string, unknown> = {}): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
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

// ISS-734: inline collision guidance mirrors handleTeamInit. Each teammate runs
// team setup on their own clone, so this output is the one every teammate sees.
describe("ISS-734: handleTeamSetup allocator guidance", () => {
  it("prints the local-allocator note when the id allocator is local (default)", async () => {
    const root = createTempGitRepo();
    writeConfig(root);
    const result = await handleTeamSetup(root, { format: "md" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("prints the note when idAllocator is explicitly local", async () => {
    const root = createTempGitRepo();
    writeConfig(root, { team: { enabled: true, idAllocator: "local" } });
    const result = await handleTeamSetup(root, { format: "md" });
    expect(result.output).toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("does NOT print the note when idAllocator is git-refs", async () => {
    const root = createTempGitRepo();
    writeConfig(root, { team: { enabled: true, idAllocator: "git-refs" } });
    const result = await handleTeamSetup(root, { format: "md" });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(LOCAL_ALLOCATOR_NOTE);
  });

  it("reports the effective allocator in json output", async () => {
    const root = createTempGitRepo();
    writeConfig(root, { team: { enabled: true, idAllocator: "git-refs" } });
    const result = await handleTeamSetup(root, { format: "json" });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed.idAllocator).toBe("git-refs");
  });
});
