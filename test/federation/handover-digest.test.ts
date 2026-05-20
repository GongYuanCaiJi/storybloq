import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHandoverDigest } from "../../src/federation/handover-digest.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

async function createNodeWithHandovers(name: string, handovers: Array<{ filename: string; content: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-digest-${name}-`));
  tmpDirs.push(dir);
  const handoversDir = join(dir, ".story", "handovers");
  await mkdir(handoversDir, { recursive: true });
  for (const h of handovers) {
    await writeFile(join(handoversDir, h.filename), h.content);
  }
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("buildHandoverDigest", () => {
  it("extracts first heading from each node's latest handover", async () => {
    const dir1 = await createNodeWithHandovers("engine", [
      { filename: "2026-05-10-session.md", content: "# Engine session 10\nSome content" },
      { filename: "2026-05-18-feature.md", content: "# Engine feature work\nMore content" },
    ]);
    const dir2 = await createNodeWithHandovers("cloud", [
      { filename: "2026-05-17-deploy.md", content: "# Cloud deployment\nDetails" },
    ]);

    const nodes = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: dir1, storyDir: join(dir1, ".story"), rawPath: dir1 }],
      ["cloud", { resolved: true, absolutePath: dir2, storyDir: join(dir2, ".story"), rawPath: dir2 }],
    ]);

    const digest = await buildHandoverDigest(nodes);
    expect(digest).toHaveLength(2);

    const engine = digest.find((d) => d.nodeName === "engine")!;
    expect(engine.heading).toBe("Engine feature work");
    expect(engine.date).toBe("2026-05-18");
    expect(engine.filename).toBe("2026-05-18-feature.md");

    const cloud = digest.find((d) => d.nodeName === "cloud")!;
    expect(cloud.heading).toBe("Cloud deployment");
    expect(cloud.date).toBe("2026-05-17");
    expect(cloud.filename).toBe("2026-05-17-deploy.md");
  });

  it("returns null heading for node with no handovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-digest-empty-"));
    tmpDirs.push(dir);
    await mkdir(join(dir, ".story", "handovers"), { recursive: true });

    const nodes = new Map<string, ResolvedNode>([
      ["empty", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);

    const digest = await buildHandoverDigest(nodes);
    expect(digest).toHaveLength(1);
    expect(digest[0]!.heading).toBeNull();
  });

  it("includes unresolved nodes with null fields", async () => {
    const nodes = new Map<string, ResolvedNode>([
      ["broken", { resolved: false, reason: "not found", rawPath: "/missing" }],
    ]);

    const digest = await buildHandoverDigest(nodes);
    expect(digest).toHaveLength(1);
    expect(digest[0]!.heading).toBeNull();
  });

  it("handles handover with leading blank lines before heading", async () => {
    const dir = await createNodeWithHandovers("frontend", [
      { filename: "2026-05-15-session.md", content: "\n\n# Late heading\nContent" },
    ]);

    const nodes = new Map<string, ResolvedNode>([
      ["frontend", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);

    const digest = await buildHandoverDigest(nodes);
    expect(digest[0]!.heading).toBe("Late heading");
  });

  it("handles non-date-prefixed filename", async () => {
    const dir = await createNodeWithHandovers("nodate", [
      { filename: "session-notes.md", content: "# Session notes\nSome content" },
    ]);
    const nodes = new Map([
      ["nodate", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);
    const digest = await buildHandoverDigest(nodes);
    expect(digest[0]!.date).toBeNull();
    expect(digest[0]!.heading).toBe("Session notes");
    expect(digest[0]!.filename).toBe("session-notes.md");
  });

  it("selects lexicographically last file even if non-date-prefixed", async () => {
    const dir = await createNodeWithHandovers("mixed", [
      { filename: "2026-05-15-session.md", content: "# Date-prefixed session\nContent" },
      { filename: "z-notes.md", content: "# Z notes\nContent" },
    ]);
    const nodes = new Map<string, ResolvedNode>([
      ["mixed", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);
    const digest = await buildHandoverDigest(nodes);
    expect(digest[0]!.filename).toBe("z-notes.md");
    expect(digest[0]!.heading).toBe("Z notes");
    expect(digest[0]!.date).toBeNull();
  });

  it("truncates heading to 120 chars", async () => {
    const longTitle = "A".repeat(150);
    const dir = await createNodeWithHandovers("long", [
      { filename: "2026-05-15-session.md", content: `# ${longTitle}\nContent` },
    ]);

    const nodes = new Map<string, ResolvedNode>([
      ["long", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);

    const digest = await buildHandoverDigest(nodes);
    expect(digest[0]!.heading!.length).toBeLessThanOrEqual(120);
  });
});
