import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema } from "../../src/models/config.js";
import { allocateDisplayId, listReservations, reserveDisplayId } from "../../src/core/remote-refs.js";
import { makeTicket, makeState, minimalConfig } from "../core/test-factories.js";

describe("config schema idAllocator", () => {
  it("accepts idAllocator: git-refs", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocator: local", () => {
    const config = { ...minimalConfig, team: { idAllocator: "local" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocatorRemote", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs", idAllocatorRemote: "upstream" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });
});

describe("allocateDisplayId", () => {
  it("with local mode returns local ID", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001" }), makeTicket({ id: "t-canonical", displayId: "T-042" })],
      config: { ...minimalConfig, team: { idAllocator: "local" } },
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-043");
    expect(result.reserved).toBe(false);
  });

  it("with undefined allocator defaults to local", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-005" })],
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-006");
    expect(result.reserved).toBe(false);
  });

  it("returns correct next ID for issues", () => {
    const state = makeState({
      issues: [],
    });
    const result = allocateDisplayId("issue", state);
    expect(result.displayId).toBe("ISS-001");
  });

  it("returns correct next ID for notes", () => {
    const state = makeState({ notes: [] });
    const result = allocateDisplayId("note", state);
    expect(result.displayId).toBe("N-001");
  });

  it("returns correct next ID for lessons", () => {
    const state = makeState({ lessons: [] });
    const result = allocateDisplayId("lesson", state);
    expect(result.displayId).toBe("L-001");
  });
});

describe("reserveDisplayId", () => {
  function createRepoWithRemote(): { root: string; remote: string } {
    const dir = mkdtempSync(join(tmpdir(), "story-remote-refs-"));
    const remote = join(dir, "remote.git");
    const root = join(dir, "work");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", root]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
    return { root, remote };
  }

  it("pushes owner payloads to refs/storybloq and lists them", async () => {
    const { root } = createRepoWithRemote();
    const state = makeState({
      tickets: [],
      config: { ...minimalConfig, team: { enabled: true, idAllocator: "git-refs" } },
    });

    const reserved = await reserveDisplayId(root, "ticket", state, "t-owner0000000001");
    const refs = await listReservations(root, "ticket", state);

    expect(reserved).toEqual({ displayId: "T-001", reserved: true });
    expect(refs).toEqual([
      expect.objectContaining({
        displayId: "T-001",
        refName: "refs/storybloq/ids/tickets/T-001",
        ownerId: "t-owner0000000001",
      }),
    ]);
  });
});
