import { describe, it, expect } from "vitest";
import { buildTicketBranchName, createTicketBranch, refreshGitWorkingState } from "../../src/autonomous/branch-affinity.js";
import { gitBranchExists } from "../../src/autonomous/git-inspector.js";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildTicketBranchName", () => {
  it("generates story/ prefix for tickets", () => {
    const name = buildTicketBranchName("T-123", "Add branch awareness");
    expect(name).toBe("story/T-123-add-branch-awareness");
  });

  it("generates fix/ prefix for issues", () => {
    const name = buildTicketBranchName("ISS-077", "Crash on load", "fix");
    expect(name).toBe("fix/ISS-077-crash-on-load");
  });

  it("truncates long titles to 40 chars", () => {
    const name = buildTicketBranchName("T-001", "This is a very long ticket title that should definitely be truncated to fit within limits");
    expect(name.length).toBeLessThanOrEqual("story/T-001-".length + 40);
  });

  it("strips special characters", () => {
    const name = buildTicketBranchName("T-050", "Fix: don't break (things) [here]!");
    expect(name).toBe("story/T-050-fix-don-t-break-things-here");
  });

  it("collapses consecutive hyphens", () => {
    const name = buildTicketBranchName("T-010", "foo --- bar");
    expect(name).toBe("story/T-010-foo-bar");
  });

  it("removes leading/trailing hyphens from slug", () => {
    const name = buildTicketBranchName("T-010", "  -leading and trailing-  ");
    expect(name).toBe("story/T-010-leading-and-trailing");
  });

  it("does not produce trailing hyphen after truncation", () => {
    const name = buildTicketBranchName("T-001", "Add Branch Awareness For The Autonomous Mode X");
    expect(name.endsWith("-")).toBe(false);
  });

  it("handles truncation at word boundary cleanly", () => {
    const name = buildTicketBranchName("T-001", "a".repeat(39) + "! x");
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("createTicketBranch", () => {
  function createTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "branch-test-"));
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'init'", { cwd: dir, stdio: "ignore" });
    return dir;
  }

  it("creates a new branch from HEAD when no mergeBase", async () => {
    const dir = createTempRepo();
    const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    const result = await createTicketBranch(
      dir,
      { branch: "main", mergeBase: null, initHead: head },
      { id: "T-001", title: "Test feature" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.branchName).toBe("story/T-001-test-feature");
      expect(result.data.created).toBe(true);
    }

    const currentBranch = execSync("git branch --show-current", { cwd: dir }).toString().trim();
    expect(currentBranch).toBe("story/T-001-test-feature");
  });

  it("checks out existing branch without creating", async () => {
    const dir = createTempRepo();
    const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
    execSync("git checkout -b story/T-002-existing", { cwd: dir, stdio: "ignore" });
    execSync("git checkout main", { cwd: dir, stdio: "ignore" });

    const result = await createTicketBranch(
      dir,
      { branch: "main", mergeBase: head },
      { id: "T-002", title: "Existing" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.branchName).toBe("story/T-002-existing");
      expect(result.data.created).toBe(false);
    }
  });

  it("returns success immediately if already on correct branch (idempotent)", async () => {
    const dir = createTempRepo();
    const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
    execSync("git checkout -b story/T-003-my-work", { cwd: dir, stdio: "ignore" });

    const result = await createTicketBranch(
      dir,
      { branch: "story/T-003-my-work", mergeBase: head },
      { id: "T-003", title: "My work" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(false);
    }
  });

  it("uses fix/ prefix for issues", async () => {
    const dir = createTempRepo();
    const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();

    const result = await createTicketBranch(
      dir,
      { branch: "main", mergeBase: head },
      { id: "ISS-077", title: "Crash on load" },
      "fix",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.branchName).toBe("fix/ISS-077-crash-on-load");
      expect(result.data.created).toBe(true);
    }
  });
});

describe("refreshGitWorkingState", () => {
  function createTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "refresh-test-"));
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'init'", { cwd: dir, stdio: "ignore" });
    return dir;
  }

  it("returns current branch and HEAD", async () => {
    const dir = createTempRepo();
    execSync("git checkout -b feature/test", { cwd: dir, stdio: "ignore" });

    const result = await refreshGitWorkingState(dir);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feature/test");
    expect(result!.expectedHead).toMatch(/^[0-9a-f]{40}$/);
    expect(result!.baseline.porcelain).toEqual([]);
  });

  it("detects dirty tracked files", async () => {
    const dir = createTempRepo();
    writeFileSync(join(dir, "file.txt"), "modified");

    const result = await refreshGitWorkingState(dir);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.baseline.dirtyTrackedFiles)).toContain("file.txt");
  });

  it("detects untracked files", async () => {
    const dir = createTempRepo();
    writeFileSync(join(dir, "new-file.txt"), "new");

    const result = await refreshGitWorkingState(dir);
    expect(result).not.toBeNull();
    expect(result!.baseline.untrackedPaths).toContain("new-file.txt");
  });
});

describe("gitBranchExists", () => {
  function createTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "exists-test-"));
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'init'", { cwd: dir, stdio: "ignore" });
    return dir;
  }

  it("returns true for existing branch", async () => {
    const dir = createTempRepo();
    execSync("git branch test-branch", { cwd: dir, stdio: "ignore" });

    const result = await gitBranchExists(dir, "test-branch");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(true);
  });

  it("returns false (not error) for non-existing branch", async () => {
    const dir = createTempRepo();

    const result = await gitBranchExists(dir, "nonexistent-branch");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });

  it("returns false for branch with special characters that doesn't exist", async () => {
    const dir = createTempRepo();

    const result = await gitBranchExists(dir, "story/T-999-some-feature");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });
});
