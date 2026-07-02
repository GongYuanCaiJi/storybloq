import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import lockfile from "proper-lockfile";
import { tryReadFile } from "../util/file-io.js";
import { atomicWrite, guardPath } from "../../core/project-loader.js";
import { ConfigSchema } from "../../models/config.js";
import {
  NodeNameSchema,
  validateOrchestratorOverlay,
} from "../../models/federation-config.js";
import { ProjectLoaderError } from "../../core/errors.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

export async function handleMigrate(
  root: string,
  format: OutputFormat,
  options: { dryRun: boolean },
): Promise<CommandResult> {
  const { dryRun } = options;
  const absRoot = resolve(root);
  const storyDir = join(absRoot, ".story");

  if (!existsSync(storyDir)) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "No .story/ directory found" })
        : "Error: No .story/ directory found",
      errorCode: "not_found",
    };
  }

  let resultOutput: string;

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(storyDir, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
      stale: 10000,
      lockfilePath: join(storyDir, ".lock"),
    });
  } catch {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "Could not acquire project lock" })
        : "Error: Could not acquire project lock",
      errorCode: "io_error",
    };
  }

  try {
    const configPath = join(storyDir, "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) {
      throw new ProjectLoaderError(
        "io_error",
        `Cannot read config: ${readResult.error.message}`,
        readResult.error,
      );
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readResult.content) as Record<string, unknown>;
    } catch {
      throw new ProjectLoaderError(
        "validation_failed",
        "config.json is not valid JSON",
      );
    }

    const baseResult = ConfigSchema.safeParse(raw);
    if (!baseResult.success) {
      const msg = baseResult.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError(
        "validation_failed",
        `config.json fails base schema: ${msg}`,
      );
    }

    const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
    if (schemaVersion >= 2) {
      resultOutput = format === "json"
        ? JSON.stringify({ version: 1, data: { migrated: false, reason: `already at schemaVersion ${schemaVersion}` } })
        : "Already migrated (schemaVersion >= 2). No changes needed.";
      return { output: resultOutput };
    }

    const isOrchestrator = raw.type === "orchestrator";
    const hasNodes =
      raw.nodes &&
      typeof raw.nodes === "object" &&
      !Array.isArray(raw.nodes) &&
      Object.keys(raw.nodes).length > 0;

    if (!isOrchestrator || !hasNodes) {
      if (dryRun) {
        resultOutput = format === "json"
          ? JSON.stringify({ version: 1, data: { migrated: false, dryRun: true, changes: ["schemaVersion: 1 -> 2"] } })
          : "Dry run: would bump schemaVersion to 2. No node migration needed.";
        return { output: resultOutput };
      }
      raw.schemaVersion = 2;
      await guardPath(configPath, absRoot);
      await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");
      resultOutput = format === "json"
        ? JSON.stringify({ version: 1, data: { migrated: true, changes: ["schemaVersion: 1 -> 2"] } })
        : "Migrated: bumped schemaVersion to 2.";
      return { output: resultOutput };
    }

    const nodes = raw.nodes as Record<string, Record<string, unknown>>;
    const changes: string[] = [];

    for (const [key] of Object.entries(nodes)) {
      const nameResult = NodeNameSchema.safeParse(key);
      if (!nameResult.success) {
        throw new ProjectLoaderError(
          "validation_failed",
          `Invalid node name "${key}": ${nameResult.error.issues.map((i) => i.message).join(", ")}. Rename the node before migrating.`,
        );
      }
    }

    for (const [key, value] of Object.entries(nodes)) {
      const before = JSON.stringify(value);
      if (value.health === undefined) value.health = "grey";
      if (value.dependsOn === undefined) value.dependsOn = [];
      if (value.stack === undefined) value.stack = "";
      if (value.role === undefined) value.role = "";
      if (value.summary === undefined) value.summary = "";
      const after = JSON.stringify(value);
      if (before !== after) {
        changes.push(`${key}: filled defaults`);
      }
    }

    raw.schemaVersion = 2;
    changes.unshift("schemaVersion: 1 -> 2");

    const overlay = validateOrchestratorOverlay(raw);
    if (!overlay.valid) {
      throw new ProjectLoaderError(
        "validation_failed",
        `Migration validation failed:\n${overlay.errors.join("\n")}`,
      );
    }

    if (dryRun) {
      const lines = ["Dry run - proposed changes:"];
      lines.push(...changes.map((c) => `  ${c}`));
      if (overlay.warnings.length > 0) {
        lines.push("Warnings:");
        lines.push(...overlay.warnings.map((w) => `  ${w}`));
      }
      resultOutput = format === "json"
        ? JSON.stringify({ version: 1, data: { migrated: false, dryRun: true, changes, warnings: overlay.warnings } })
        : lines.join("\n");
      return { output: resultOutput };
    }

    await guardPath(configPath, absRoot);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");

    const lines = [`Migrated ${Object.keys(nodes).length} node(s):`];
    lines.push(...changes.map((c) => `  ${c}`));
    if (overlay.warnings.length > 0) {
      lines.push("Warnings:");
      lines.push(...overlay.warnings.map((w) => `  ${w}`));
    }
    resultOutput = format === "json"
      ? JSON.stringify({ version: 1, data: { migrated: true, changes, warnings: overlay.warnings } })
      : lines.join("\n");
    return { output: resultOutput };
  } catch (err) {
    if (err instanceof ProjectLoaderError) {
      return {
        output: format === "json"
          ? JSON.stringify({ version: 1, error: err.message })
          : `Error: ${err.message}`,
        errorCode: err.code,
      };
    }
    throw err;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // lock release failure is non-fatal
      }
    }
  }
}
