import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { supportsAgentView } from "../../src/core/dispatch-plan.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

describe("agent-view module", () => {
  let execFileSync: ReturnType<typeof vi.fn>;
  let spawnMod: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    execFileSync = cp.execFileSync as unknown as ReturnType<typeof vi.fn>;
    spawnMod = cp.spawn as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("detectClaudeVersion", () => {
    it("returns version string when claude is available", async () => {
      execFileSync.mockReturnValue("Claude Code v2.1.142\n");
      const { detectClaudeVersion } = await import("../../src/autonomous/agent-view.js");
      const version = detectClaudeVersion();
      expect(version).toBe("2.1.142");
    });

    it("returns null when claude is not found", async () => {
      execFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
      const { detectClaudeVersion } = await import("../../src/autonomous/agent-view.js");
      const version = detectClaudeVersion();
      expect(version).toBeNull();
    });

    it("returns null for unparseable output", async () => {
      execFileSync.mockReturnValue("some garbage output\n");
      const { detectClaudeVersion } = await import("../../src/autonomous/agent-view.js");
      const version = detectClaudeVersion();
      expect(version).toBeNull();
    });
  });

  describe("spawnBackgroundAgent", () => {
    it("spawns with /story auto prompt and correct args", async () => {
      const mockChild = { unref: vi.fn(), on: vi.fn() };
      spawnMod.mockReturnValue(mockChild);
      const { spawnBackgroundAgent } = await import("../../src/autonomous/agent-view.js");

      const result = spawnBackgroundAgent({
        cwd: "/project",
        ids: ["T-001"],
        name: "T-001: Some ticket",
      });

      expect(result.success).toBe(true);
      expect(spawnMod).toHaveBeenCalledWith(
        "claude",
        ["--bg", "--name", "T-001: Some ticket", "/story auto T-001"],
        { cwd: "/project", detached: true, stdio: "ignore" },
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it("passes --model when specified", async () => {
      const mockChild = { unref: vi.fn(), on: vi.fn() };
      spawnMod.mockReturnValue(mockChild);
      const { spawnBackgroundAgent } = await import("../../src/autonomous/agent-view.js");

      spawnBackgroundAgent({
        cwd: "/project",
        ids: ["T-001"],
        model: "opus",
      });

      expect(spawnMod).toHaveBeenCalledWith(
        "claude",
        ["--bg", "--model", "opus", "/story auto T-001"],
        expect.any(Object),
      );
    });

    it("joins multiple IDs in the prompt", async () => {
      const mockChild = { unref: vi.fn(), on: vi.fn() };
      spawnMod.mockReturnValue(mockChild);
      const { spawnBackgroundAgent } = await import("../../src/autonomous/agent-view.js");

      spawnBackgroundAgent({
        cwd: "/project",
        ids: ["T-001", "ISS-077"],
      });

      expect(spawnMod).toHaveBeenCalledWith(
        "claude",
        ["--bg", "/story auto T-001 ISS-077"],
        expect.any(Object),
      );
    });

    it("returns error on spawn failure", async () => {
      spawnMod.mockImplementation(() => { throw new Error("spawn ENOENT"); });
      const { spawnBackgroundAgent } = await import("../../src/autonomous/agent-view.js");

      const result = spawnBackgroundAgent({
        cwd: "/project",
        ids: ["T-001"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("spawn ENOENT");
    });

    it("omits --name and --model when not provided", async () => {
      const mockChild = { unref: vi.fn(), on: vi.fn() };
      spawnMod.mockReturnValue(mockChild);
      const { spawnBackgroundAgent } = await import("../../src/autonomous/agent-view.js");

      spawnBackgroundAgent({
        cwd: "/project",
        ids: ["T-001"],
      });

      expect(spawnMod).toHaveBeenCalledWith(
        "claude",
        ["--bg", "/story auto T-001"],
        expect.any(Object),
      );
    });
  });
});

describe("supportsAgentView (re-exported from dispatch-plan)", () => {
  it("handles edge version exactly at boundary", () => {
    expect(supportsAgentView("2.1.139")).toBe(true);
    expect(supportsAgentView("2.1.138")).toBe(false);
  });
});
