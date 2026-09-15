/**
 * T-507 commit D: the Mods (function hooks) copy that `storybloq setup-skill`
 * writes under ~/.claude/skills/storybloq/ and the version-marker refresh
 * keeps current.
 *
 * The copy is the plugin's manifest (with `skills` dropped: the copy carries
 * no skill directory) plus the hooks runtime files, and a GENERATED
 * hooks/install.ts whose `resolveStorybloqBin()` answers the absolute path
 * of the global storybloq binary. The client loads a Mod with a PATH the
 * shell did not set, so the bare name the repository copy answers is not
 * enough there.
 *
 * Pen hold 1 (T-507): when the global binary moves (an nvm switch), the
 * version-marker auto-refresh must re-resolve that path. M-NO-RERESOLVE
 * (the refresh copies the files but keeps the old install.ts) goes red
 * against the "moves with the binary" test below.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_SRC = join(PKG_ROOT, "plugins", "storybloq");

async function fakeBin(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "storybloq");
  await writeFile(bin, "#!/bin/sh\n", "utf-8");
  await chmod(bin, 0o755);
  return bin;
}

describe("renderInstallModule (T-507 D)", () => {
  it("answers the absolute path as a string literal, JSON-escaped", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const text = renderInstallModule("/Users/a b/.nvm/versions/node/v22/bin/storybloq");
    expect(text).toContain('return "/Users/a b/.nvm/versions/node/v22/bin/storybloq";');
    expect(text).toContain("export function resolveStorybloqBin(): string {");
    expect(text).not.toContain("\u2014");
  });

  it("falls back to the bare name when no binary resolved, and says so in the module", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const text = renderInstallModule(null);
    expect(text).toContain('return "storybloq";');
    expect(text).toMatch(/not (be )?resolved|no global/i);
  });

  it("escapes a path that carries a quote or a backslash so the module still parses", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const text = renderInstallModule('C:\\Users\\o"k\\storybloq.cmd');
    expect(text).toContain(JSON.stringify('C:\\Users\\o"k\\storybloq.cmd'));
  });
});

describe("installMods (T-507 D)", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the manifest without `skills`, the hooks runtime files, no test file, and the generated install.ts", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    const result = await installMods({ bin });
    const dir = modsDir();
    expect(dir).toBe(join(tempDir, ".claude", "skills", "storybloq"));
    expect(result.dir).toBe(dir);
    expect(result.bin).toBe(bin);

    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const source = JSON.parse(await readFile(join(PLUGIN_SRC, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("skills");
    expect(manifest["hooks"]).toBe("./hooks/hooks.json");
    expect(manifest["userConfig"]).toEqual(source["userConfig"]);
    expect(manifest["version"]).toBe(source["version"]);

    const hooks = (await readdir(join(dir, "hooks"))).sort();
    const sourceHooks = (await readdir(join(PLUGIN_SRC, "hooks"))).filter((f) => !f.endsWith(".test.ts")).sort();
    expect(hooks).toEqual(sourceHooks);
    expect(hooks.some((f) => f.endsWith(".test.ts"))).toBe(false);
    for (const name of hooks) {
      if (name === "install.ts") continue;
      expect(await readFile(join(dir, "hooks", name), "utf-8")).toBe(await readFile(join(PLUGIN_SRC, "hooks", name), "utf-8"));
    }
    expect(await readFile(join(dir, "hooks", "install.ts"), "utf-8")).toContain(`return ${JSON.stringify(bin)};`);
    expect(result.written).toContain("hooks/install.ts");
    expect(result.written).toContain(".claude-plugin/plugin.json");
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("leaves no staging directory behind and replaces a previous copy whole", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const first = await fakeBin(join(tempDir, "a"));
    await installMods({ bin: first });
    await writeFile(join(modsDir(), "hooks", "stray.ts"), "// left by an older version\n", "utf-8");
    const second = await fakeBin(join(tempDir, "b"));
    await installMods({ bin: second });
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain(`return ${JSON.stringify(second)};`);
    expect(existsSync(join(modsDir(), "hooks", "stray.ts"))).toBe(false);
    const siblings = await readdir(join(tempDir, ".claude", "skills"));
    expect(siblings).toEqual(["storybloq"]);
  });

  it("with no binary resolved (empty PATH) still installs, answering the bare name", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const result = await installMods({ bin: null });
    expect(result.bin).toBeNull();
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain('return "storybloq";');
  });

  it("a missing plugin source is an error, and a previous copy is left untouched (partial failure)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    await expect(installMods({ bin: "/elsewhere/storybloq", sourceDir: join(tempDir, "no-such-plugin") })).rejects.toThrow(/plugin source|not found/i);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toBe(before);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  });

  it("a source whose hooks are incomplete is refused before anything is swapped in", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    // A source with a manifest but no hooks/mod.ts: the copy would load nothing.
    const broken = join(tempDir, "broken-plugin");
    await mkdir(join(broken, ".claude-plugin"), { recursive: true });
    await mkdir(join(broken, "hooks"), { recursive: true });
    await writeFile(join(broken, ".claude-plugin", "plugin.json"), "{}", "utf-8");
    await expect(installMods({ bin, sourceDir: broken })).rejects.toThrow(/mod\.ts|hooks\.json/);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toBe(before);
  });

  it("the copy passes the client's own validation and scans the same hooks and calls as the repository plugin", async () => {
    let available = true;
    try {
      execFileSync("claude", ["--version"], { stdio: "pipe" });
    } catch {
      available = false;
    }
    expect(available, "claude is not on PATH, so the installed copy cannot be validated").toBe(true);
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const env = { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" };
    const scanOf = (dir: string) =>
      execFileSync("claude", ["plugin", "validate", dir], { encoding: "utf8", env })
        .split("\n")
        .filter((row) => row.includes("mod.ts hooks:") || row.includes("mod.ts calls:") || row.includes("env reads:"))
        .map((row) => row.trim());
    const installed = execFileSync("claude", ["plugin", "validate", modsDir()], { encoding: "utf8", env });
    expect(installed).toContain("Validation passed");
    expect(scanOf(modsDir())).toEqual(scanOf(PLUGIN_SRC));
  });
});

describe("the version-marker refresh re-resolves the binary (pen hold 1, T-507)", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-refresh-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tempDir;
    // A stale Claude skill install, as skill-version-marker.test.ts sets one up.
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    await mkdir(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
    const { vi } = await import("vitest");
    vi.resetModules();
  });

  it("moves the generated path with the binary: installed under one PATH, refreshed under another (M-NO-RERESOLVE)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const oldBin = await fakeBin(join(tempDir, "nvm", "v20", "bin"));
    await installMods({ bin: oldBin });
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain(JSON.stringify(oldBin));

    const newBin = await fakeBin(join(tempDir, "nvm", "v22", "bin"));
    process.env.PATH = dirname(newBin);
    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

    const installTs = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    expect(installTs).toContain(`return ${JSON.stringify(newBin)};`);
    expect(installTs).not.toContain(oldBin);
    // The runtime files came along too, not only install.ts.
    expect(await readFile(join(modsDir(), "hooks", "roster.ts"), "utf-8")).toBe(
      await readFile(join(PLUGIN_SRC, "hooks", "roster.ts"), "utf-8"),
    );
  });

  it("installs no Mods copy where none was installed: the refresh is not a setup", async () => {
    const { modsDir } = await import("../../src/core/mods-install.js");
    process.env.PATH = dirname(await fakeBin(join(tempDir, "bin")));
    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(existsSync(modsDir())).toBe(false);
  });

  it("with the binary gone from PATH the refresh keeps the copy loadable, answering the bare name", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    await installMods({ bin: await fakeBin(join(tempDir, "old", "bin")) });
    process.env.PATH = "";
    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain('return "storybloq";');
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  });
});
