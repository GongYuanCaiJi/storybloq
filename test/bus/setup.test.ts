import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash } from "../../src/bus/canonical.js";
import { busSummary, classifyBusRuntime, initializeBus, joinEndpoint } from "../../src/bus/index.js";
import { runBusCli } from "./cli-harness.js";

// D4 guided setup: idempotent, resumable, one command per task. All setup tests
// use --delivery poll: the live path mutates the real ~/.claude and ~/.codex hook
// files, which a test must never touch. Poll delivery skips hook mutation.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

async function busEnabled(root: string): Promise<boolean> {
  const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
  return config.features?.bus === true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setup(root: string, extra: string[] = []): Promise<{ data: Record<string, unknown>; error?: { code: string; message: string } }> {
  const { stdout } = await runBusCli(root, [
    "bus", "setup", "--format", "json", "--client", "claude", "--delivery", "poll", ...extra,
  ]);
  return JSON.parse(stdout);
}

// Recursively lists a directory's entries as sorted relative paths (directories
// suffixed with `/`), used to prove a runtime tree is byte-for-byte unchanged. Each
// regular file carries a content hash so an IN-PLACE mutation of an existing file (an
// endpoint record, a counter) that preserves the tree SHAPE is still detected by a
// before/after comparison, not just added/removed paths. Symlinks/special entries are
// tagged by kind and never traversed.
async function walkTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      out.push(`${prefix}${entry.name}/`);
      out.push(...(await walkTree(join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      const bytes = await readFile(join(dir, entry.name));
      out.push(`${prefix}${entry.name}@${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
    } else {
      out.push(`${prefix}${entry.name}#${entry.isSymbolicLink() ? "symlink" : "special"}`);
    }
  }
  return out.sort();
}

// Hand-builds a single-endpoint, caller-owned, thread-free v1 runtime that drains
// cleanly (the caller's own endpoint is exempt from the migration offline proof and
// there is no pending mail), so `bus setup` upgrades it to v2 with migrated:true.
async function createDrainableV1(name: string, taskId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  const canonical = await realpath(root);
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }
  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");
  const endpointId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");
  return root;
}

describe("Storybloq Bus guided setup (D4)", () => {
  it("takes a disabled project to waiting_for_peer with the handoff line", async () => {
    const root = await project("bus-setup-fresh");
    const parsed = await setup(root, ["--task-id", "claude-solo"]);
    expect(parsed.data).toMatchObject({
      setupState: "waiting_for_peer",
      deliveryMode: "poll",
      endpoints: 1,
    });
    expect(parsed.data.handoff).toContain('Connect this task to Storybloq Bus.');
    expect(parsed.data.completedSteps).toContain("join-endpoint");
    expect(parsed.data.completedSteps).toContain("poll-delivery (hooks skipped)");
    expect(parsed.data.trackedChanges).toEqual(
      expect.arrayContaining([".story/config.json", ".story/.gitignore"]),
    );
  });

  it("is idempotent: a rerun refreshes the existing endpoint and reports no tracked changes", async () => {
    const root = await project("bus-setup-idempotent");
    await setup(root, ["--task-id", "claude-solo"]);
    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(rerun.data.completedSteps).toContain("refresh-endpoint");
    // The first run already enabled features.bus and completed the .gitignore, so
    // the idempotent rerun changes nothing tracked (no config/gitignore churn).
    expect(rerun.data.trackedChanges).toEqual([]);
  });

  it("fails a live preflight and mutates nothing when the base Claude hooks are absent", async () => {
    const root = await project("bus-setup-live-preflight");
    // Isolate HOME so the live preflight inspects a settings.json that is missing
    // its base SessionStart/Stop hooks, and so nothing can touch the real ~/.claude.
    const isolatedHome = await mkdtemp(join(tmpdir(), "bus-setup-home-"));
    roots.push(isolatedHome);
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = isolatedHome;
      const { stdout } = await runBusCli(root, [
        "bus", "setup", "--format", "json", "--client", "claude",
        "--delivery", "live", "--task-id", "claude-solo",
      ]);
      const parsed = JSON.parse(stdout);
      // Preflight fails read-only with setup guidance.
      expect(parsed.error?.code).toBe("io_error");
      expect(parsed.error?.message).toContain("setup --client claude");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
    // Zero mutation: the feature never flipped and no runtime was created.
    expect(await busEnabled(root)).toBe(false);
    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
  });

  it("resumes from an initialized-but-not-joined runtime", async () => {
    const root = await project("bus-setup-resume-init");
    await initializeBus(root); // runtime exists, no endpoint yet
    const parsed = await setup(root, ["--task-id", "claude-solo"]);
    expect(parsed.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(parsed.data.completedSteps).toContain("join-endpoint");
  });

  it("skips hook mutation under --delivery poll", async () => {
    const root = await project("bus-setup-poll");
    await setup(root, ["--task-id", "claude-solo"]);
    const summary = await busSummary(root);
    expect(summary.deliveryMode).toBe("poll");
    expect(summary.hookDelivery).toEqual({ claude: false, codex: false });
  });

  it("fails preflight and mutates nothing when identity is missing", async () => {
    const root = await project("bus-setup-no-identity");
    // No --task-id and no ambient session id (test setup clears the env).
    const { stdout } = await runBusCli(root, ["bus", "setup", "--format", "json", "--client", "claude", "--delivery", "poll"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error?.code).toBe("invalid_input");
    // Preflight ran before any persistent mutation.
    expect(await busEnabled(root)).toBe(false);
  });

  it("fails preflight and mutates nothing when the surface is incompatible with the client", async () => {
    const root = await project("bus-setup-surface");
    // codex_desktop is a Codex surface; the default claude client cannot use it, so
    // the preflight rejects it as invalid_input BEFORE any mutation, regardless of
    // whether a client process is detectable in this environment.
    const parsed = await setup(root, ["--task-id", "claude-solo", "--surface", "codex_desktop"]);
    expect(parsed.error?.code).toBe("invalid_input");
    expect(await busEnabled(root)).toBe(false);
  });

  it("fails preflight and mutates nothing when a Codex surface cannot be resolved", async () => {
    const root = await project("bus-setup-codex-nosurface");
    const gitignorePath = join(root, ".story", ".gitignore");
    const gitignoreBefore = await readFile(gitignorePath, "utf-8").catch(() => null);

    // A Codex client with an explicit task identity but NO --surface: process
    // ancestry detection returns null here (the test runner is not a codex process),
    // so the surface is unresolved and the preflight must reject BEFORE any mutation
    // rather than fall through with an undetermined surface. This exercises the same
    // no-codex-process seam the other surface tests rely on.
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "json", "--client", "codex", "--delivery", "poll", "--task-id", "codex-solo",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error?.code).toBe("invalid_input");
    expect(parsed.error?.message).toContain("Cannot determine the client surface safely");

    // Zero mutation: the feature never flipped, no runtime was created, and the
    // gitignore is byte-identical (or still absent) to its pre-call state.
    expect(await busEnabled(root)).toBe(false);
    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
    expect(await readFile(gitignorePath, "utf-8").catch(() => null)).toBe(gitignoreBefore);
  });

  it("reaches ready once a second participant runs setup", async () => {
    const root = await project("bus-setup-ready");
    await setup(root, ["--task-id", "claude-first"]);
    const second = await setup(root, ["--task-id", "claude-second"]);
    expect(second.data).toMatchObject({ setupState: "ready", endpoints: 2 });
    expect(second.data.handoff).toBeNull();
  });

  it("rejects a THIRD-task setup with conflict and mutates nothing before the capacity rejection (F8)", async () => {
    const root = await project("bus-setup-capacity");
    await setup(root, ["--task-id", "claude-first"]);
    expect((await setup(root, ["--task-id", "claude-second"])).data).toMatchObject({ setupState: "ready" });

    // Snapshot config, .gitignore, and the full runtime tree at the ready state.
    const configBefore = await readFile(join(root, ".story", "config.json"), "utf-8");
    const gitignoreBefore = await readFile(join(root, ".story", ".gitignore"), "utf-8");
    const treeBefore = await walkTree(join(root, ".story", "bus"));

    // A third task cannot join two active endpoints; setup rejects with conflict.
    const endpointsBefore = (await readdir(join(root, ".story", "bus", "endpoints"))).sort();
    expect(endpointsBefore).toHaveLength(2);
    const third = await setup(root, ["--task-id", "claude-third"]);
    expect(third.error?.code).toBe("conflict");

    // config.json/.gitignore are unchanged, but on an already-ready runtime those
    // writes are idempotent, so their invariance alone cannot prove the capacity rule
    // fired before any mutation. The concrete, non-idempotent mutation the capacity
    // rule exists to prevent is minting a THIRD endpoint record + mailbox; assert that
    // never happened (the endpoints dir still holds exactly the two originals, and the
    // full runtime tree is byte-identical), which no third endpoint could satisfy.
    expect(await readFile(join(root, ".story", "config.json"), "utf-8")).toBe(configBefore);
    expect(await readFile(join(root, ".story", ".gitignore"), "utf-8")).toBe(gitignoreBefore);
    expect((await readdir(join(root, ".story", "bus", "endpoints"))).sort()).toEqual(endpointsBefore);
    expect(await walkTree(join(root, ".story", "bus"))).toEqual(treeBefore);

    // Same-task reruns of the two existing endpoints still succeed (no over-rejection).
    expect((await setup(root, ["--task-id", "claude-first"])).data).toMatchObject({ setupState: "ready" });
    expect((await setup(root, ["--task-id", "claude-second"])).data).toMatchObject({ setupState: "ready" });
  });

  it("heals a missing pending directory on a same-task rejoin (#4)", async () => {
    const root = await project("bus-rejoin-heal");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    expect(first.existing).toBe(false);

    // A crash dropped this endpoint's mailbox/pending child. The strict layout
    // assertion would otherwise brick every endpoint-scoped op; join resolves the
    // base layout so the heal below is reachable.
    const pendingDir = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId, "pending");
    await rm(pendingDir, { recursive: true, force: true });

    // The same-task rejoin succeeds (does not throw corrupt), keeps the same
    // endpointId, and recreates pending as a real directory.
    const rejoin = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    expect(rejoin.existing).toBe(true);
    expect(rejoin.endpoint.endpointId).toBe(first.endpoint.endpointId);
    expect((await stat(pendingDir)).isDirectory()).toBe(true);

    // The full layout is whole again; readiness reflects the sole endpoint.
    expect((await busSummary(root)).setupState).toBe("waiting_for_peer");
  });

  it("heals a missing pending directory through a rerun of the bus setup CLI (#R6-I)", async () => {
    const root = await project("bus-setup-rejoin-heal");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    expect(first.error).toBeUndefined();
    const endpointId = first.data.endpointId as string;
    expect(first.data).toMatchObject({ setupState: "waiting_for_peer" });

    // A crash dropped this endpoint's mailbox/pending child. The strict layout
    // assertion would otherwise brick every endpoint-scoped op.
    const pendingDir = join(root, ".story", "bus", "mailboxes", endpointId, "pending");
    await rm(pendingDir, { recursive: true, force: true });
    expect(await pathExists(pendingDir)).toBe(false);

    // Rerunning the SAME setup CLI heals the layout: setup always routes through
    // joinEndpoint first (its relaxed resolver recreates the missing pending dir),
    // then refreshes the existing endpoint. It must not throw corrupt, must keep the
    // same endpoint id, and must report the refresh-endpoint completed step.
    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error).toBeUndefined();
    expect(rerun.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(rerun.data.endpointId).toBe(endpointId);
    expect(rerun.data.completedSteps).toContain("refresh-endpoint");
    // The pending directory is a real directory again.
    expect((await stat(pendingDir)).isDirectory()).toBe(true);
  });

  it("fails closed without traversal when a same-task rejoin finds a symlinked mailbox (#R7)", async () => {
    const root = await project("bus-rejoin-symlink-mailbox");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });

    // Replace this endpoint's mailbox dir with a symlink to an external directory. A
    // recursive mkdir of mailbox/pending would follow it and create/write OUTSIDE
    // .story/bus; the heal must reject the symlink before any mkdir runs.
    const mailbox = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId);
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(mailbox, { recursive: true, force: true });
    await symlink(external, mailbox);

    await expect(joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" }))
      .rejects.toMatchObject({ code: "corrupt" });
    // The external symlink target is untouched: no pending dir was created through it.
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed when a same-task rejoin finds a symlinked pending child (#R7)", async () => {
    const root = await project("bus-rejoin-symlink-pending");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });

    const pending = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId, "pending");
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(pending, { recursive: true, force: true });
    await symlink(external, pending);

    await expect(joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed through the bus setup CLI when the endpoint mailbox is a symlink (#R7)", async () => {
    const root = await project("bus-setup-symlink-mailbox");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    const endpointId = first.data.endpointId as string;

    const mailbox = join(root, ".story", "bus", "mailboxes", endpointId);
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(mailbox, { recursive: true, force: true });
    await symlink(external, mailbox);

    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error?.code).toBe("corrupt");
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed through the bus setup CLI when the endpoint pending child is a symlink (#R7)", async () => {
    const root = await project("bus-setup-symlink-pending");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    const endpointId = first.data.endpointId as string;

    const pending = join(root, ".story", "bus", "mailboxes", endpointId, "pending");
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(pending, { recursive: true, force: true });
    await symlink(external, pending);

    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error?.code).toBe("corrupt");
    expect(await readdir(external)).toHaveLength(0);
  });

  it("reports migrated:false when joining an already-initialized v2 runtime through setup", async () => {
    // A second participant runs setup against an already-initialized v2 runtime; no
    // migration occurs, so migrated is false and it simply joins to reach ready.
    const root = await project("bus-setup-no-migrate");
    await initializeBus(root);
    await joinEndpoint(root, { client: "codex", clientTaskId: "codex-peer", surface: "codex_desktop" });
    const parsed = await setup(root, ["--task-id", "claude-second"]);
    expect(parsed.data).toMatchObject({ migrated: false, setupState: "ready" });
  });

  it("reports migrated:true when upgrading a drainable v1 runtime through setup", async () => {
    // A genuine v1 runtime (caller-owned, drainable) upgraded through setup migrates to
    // v2 and reports migrated:true.
    const root = await createDrainableV1("bus-setup-v1-migrate", "codex-drain");
    expect(await classifyBusRuntime(root)).toBe("v1");
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "json", "--client", "codex", "--task-id", "codex-drain",
      "--surface", "codex_desktop", "--delivery", "poll",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ migrated: true });
    expect(await classifyBusRuntime(root)).toBe("v2");
  });
});
