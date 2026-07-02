import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  shouldEmitUpdateBanner,
  refreshUpdateCacheInBackground,
  checkForUpdate,
} from "../../src/core/update-check.js";

// ISS-736: first coverage for the banner guard. The command guard is the
// primary lock (interactive `git merge` gives the driver a real TTY).
describe("shouldEmitUpdateBanner (ISS-736)", () => {
  const tty = { stderrIsTTY: true, env: {} as Record<string, string | undefined> };

  it("suppresses for the merge-driver command even on a TTY", () => {
    expect(shouldEmitUpdateBanner({ ...tty, command: "merge-driver" })).toBe(false);
  });

  it("suppresses when stderr is not a TTY", () => {
    expect(shouldEmitUpdateBanner({ stderrIsTTY: false, env: {}, command: "status" })).toBe(false);
  });

  it("suppresses when NO_UPDATE_NOTIFIER is set", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { NO_UPDATE_NOTIFIER: "1" }, command: "status" })).toBe(false);
  });

  it("suppresses when CI is set, including CI=false (documented choice)", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "true" }, command: "status" })).toBe(false);
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "false" }, command: "status" })).toBe(false);
  });

  it("emits on a TTY with a clean env and an ordinary command", () => {
    expect(shouldEmitUpdateBanner({ ...tty, command: "status" })).toBe(true);
  });

  it("empty-string env values do not suppress", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "", NO_UPDATE_NOTIFIER: "" }, command: "status" })).toBe(true);
  });
});

// ISS-777: the update check previously fetched the npm registry
// UNCONDITIONALLY on every refreshUpdateCacheInBackground call (no cache-TTL
// gate, no env opt-out), so every Claude hook / CLI dispatch / MCP status
// phoned home. The once-per-day cache and the NO_UPDATE_NOTIFIER/CI opt-outs
// must gate the FETCH itself; the opt-outs are enforced at the single fetch
// site so EVERY caller (refreshUpdateCacheInBackground, checkForUpdate, and
// any future one) inherits them.
describe("npm-registry fetch gating (ISS-777)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCI: string | undefined;
  let originalNoNotifier: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function writeCacheFile(fetchedAt: number, latestVersion = "1.0.0"): void {
    const dir = join(tempHome, ".claude", "storybloq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "update-check.json"), JSON.stringify({ latestVersion, fetchedAt }), "utf-8");
  }

  beforeEach(() => {
    tempHome = join(tmpdir(), `storybloq-uc-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    originalHome = process.env.HOME;
    originalCI = process.env.CI;
    originalNoNotifier = process.env.NO_UPDATE_NOTIFIER;
    process.env.HOME = tempHome;
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) }) as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    if (originalNoNotifier === undefined) delete process.env.NO_UPDATE_NOTIFIER;
    else process.env.NO_UPDATE_NOTIFIER = originalNoNotifier;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT fetch when the cache is fresh (within 24h)", async () => {
    writeCacheFile(Date.now());
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches when the cache is stale (older than 24h)", async () => {
    writeCacheFile(Date.now() - DAY_MS - 60_000);
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fetches when no cache exists", async () => {
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when NO_UPDATE_NOTIFIER is set", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT fetch when CI is set", async () => {
    process.env.CI = "1";
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Fix round: the opt-out must live at the fetch site, not only in
  // refreshUpdateCacheInBackground, or checkForUpdate on a cold/stale cache
  // bypasses the privacy opt-out.
  it("checkForUpdate does NOT fetch on a cold cache when NO_UPDATE_NOTIFIER is set", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toBeNull();
  });

  it("checkForUpdate does NOT fetch on a cold cache when CI is set", async () => {
    process.env.CI = "1";
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toBeNull();
  });

  it("checkForUpdate still fetches on a cold cache with a clean env", async () => {
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(info).toEqual({ currentVersion: "1.0.0", latestVersion: "9.9.9", updateAvailable: true });
  });
});
