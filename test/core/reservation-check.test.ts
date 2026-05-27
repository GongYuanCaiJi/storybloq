import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fetchLocalReservationTags, classifyReservations } from "../../src/core/reservation-check.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "res-check-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function createReservationRef(root: string, plural: string, displayId: string, ownerId?: string): void {
  const payload = JSON.stringify({
    type: plural.replace(/s$/, ""),
    displayId,
    ownerId: ownerId ?? null,
    reservedAt: "2026-05-26T00:00:00.000Z",
  });
  const objectId = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: payload,
    encoding: "utf-8",
  }).trim();
  execFileSync("git", ["update-ref", `refs/storybloq/ids/${plural}/${displayId}`, objectId], { cwd: root });
}

function fakeState(items: { type: string; id: string; displayId?: string }[]): any {
  return {
    tickets: items.filter((i) => i.type === "ticket").map((i) => ({ id: i.id, displayId: i.displayId })),
    issues: items.filter((i) => i.type === "issue").map((i) => ({ id: i.id, displayId: i.displayId })),
    notes: items.filter((i) => i.type === "note").map((i) => ({ id: i.id, displayId: i.displayId })),
    lessons: items.filter((i) => i.type === "lesson").map((i) => ({ id: i.id, displayId: i.displayId })),
  };
}

describe("T-392: reservation-check", () => {
  describe("fetchLocalReservationTags", () => {
    it("returns correct reservation refs from local repo", () => {
      const root = createTempGitRepo();
      createReservationRef(root, "tickets", "T-001");
      createReservationRef(root, "tickets", "T-002");
      createReservationRef(root, "issues", "ISS-001");
      const result = fetchLocalReservationTags(root);
      expect(result.tags.get("ticket")?.has("T-001")).toBe(true);
      expect(result.tags.get("ticket")?.has("T-002")).toBe(true);
      expect(result.tags.get("issue")?.has("ISS-001")).toBe(true);
    });

    it("handles empty reservation ref list gracefully", () => {
      const root = createTempGitRepo();
      const result = fetchLocalReservationTags(root);
      expect(result.tags.size).toBe(0);
    });

    it("ignores malformed reservation refs", () => {
      const root = createTempGitRepo();
      createReservationRef(root, "tickets", "T-001");
      const payload = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: "{}",
        encoding: "utf-8",
      }).trim();
      execFileSync("git", ["update-ref", "refs/storybloq/ids/unknown/X-001", payload], { cwd: root });
      execFileSync("git", ["update-ref", "refs/unrelated/tag", payload], { cwd: root });
      const result = fetchLocalReservationTags(root);
      expect(result.tags.get("ticket")?.has("T-001")).toBe(true);
      expect(result.tags.has("unknown")).toBeFalsy();
    });

    it("reads reservation owner payloads", () => {
      const root = createTempGitRepo();
      createReservationRef(root, "tickets", "T-001", "t-owner");
      const result = fetchLocalReservationTags(root);
      expect(result.owners.get("ticket")?.get("T-001")).toBe("t-owner");
    });
  });

  describe("classifyReservations", () => {
    it("valid when item with displayId exists", () => {
      const tags = new Map([["ticket", new Set(["T-001"])]]);
      const state = fakeState([{ type: "ticket", id: "t-abc", displayId: "T-001" }]);
      const health = classifyReservations(tags, state);
      expect(health.valid.get("ticket")?.has("T-001")).toBe(true);
      expect(health.orphan.get("ticket")?.has("T-001")).toBeFalsy();
    });

    it("orphan when no item has that displayId", () => {
      const tags = new Map([["ticket", new Set(["T-999"])]]);
      const state = fakeState([{ type: "ticket", id: "t-abc", displayId: "T-001" }]);
      const health = classifyReservations(tags, state);
      expect(health.orphan.get("ticket")?.has("T-999")).toBe(true);
    });

    it("handles empty tag list", () => {
      const tags = new Map<string, Set<string>>();
      const state = fakeState([{ type: "ticket", id: "t-abc", displayId: "T-001" }]);
      const health = classifyReservations(tags, state);
      expect(health.valid.size).toBe(0);
      expect(health.orphan.size).toBe(0);
    });

    it("mismatched when owner payload points at a different canonical item", () => {
      const reservations = {
        tags: new Map([["ticket", new Set(["T-001"])]]),
        owners: new Map([["ticket", new Map([["T-001", "t-owner"]])]]),
      };
      const state = fakeState([{ type: "ticket", id: "t-other", displayId: "T-001" }]);
      const health = classifyReservations(reservations, state);
      expect(health.mismatched.get("ticket")?.has("T-001")).toBe(true);
      expect(health.valid.get("ticket")?.has("T-001")).toBeFalsy();
    });
  });
});
