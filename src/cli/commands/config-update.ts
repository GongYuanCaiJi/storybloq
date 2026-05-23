import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { withProjectLock, atomicWrite, guardPath } from "../../core/project-loader.js";
import { ConfigSchema } from "../../models/config.js";
import { ProjectLoaderError } from "../../core/errors.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/**
 * Handle `storybloq config set-overrides`.
 *
 * Merge semantics: keys in --json overwrite existing, keys not provided are preserved.
 * Explicit null removes a key. --clear removes recipeOverrides entirely.
 * Validates merged config with ConfigSchema before writing.
 */
export async function handleConfigSetOverrides(
  root: string,
  format: OutputFormat,
  options: { json?: string; clear?: boolean },
): Promise<CommandResult> {
  const { json: jsonArg, clear } = options;

  if (!clear && !jsonArg) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "Provide --json or --clear" })
        : "Error: Provide --json or --clear",
      errorCode: "invalid_input",
    };
  }

  // Parse provided JSON
  let parsedOverrides: Record<string, unknown> = {};
  if (jsonArg) {
    try {
      parsedOverrides = JSON.parse(jsonArg) as Record<string, unknown>;
      if (typeof parsedOverrides !== "object" || parsedOverrides === null || Array.isArray(parsedOverrides)) {
        return {
          output: format === "json"
            ? JSON.stringify({ version: 1, error: "Invalid JSON: expected an object" })
            : "Error: Invalid JSON: expected an object",
          errorCode: "invalid_input",
        };
      }
    } catch {
      return {
        output: format === "json"
          ? JSON.stringify({ version: 1, error: "Invalid JSON syntax" })
          : "Error: Invalid JSON syntax",
        errorCode: "invalid_input",
      };
    }
  }

  let resultOverrides: Record<string, unknown> | null = null;

  await withProjectLock(root, { strict: false }, async () => {
    // Read current config as raw JSON (preserves all keys)
    const configPath = join(root, ".story", "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) throw new ProjectLoaderError("io_error", `Cannot read config: ${readResult.error.message}`, readResult.error);
    const raw = JSON.parse(readResult.content) as Record<string, unknown>;

    if (clear) {
      delete raw.recipeOverrides;
    } else {
      // Merge: existing recipeOverrides + provided overrides
      const existing = (raw.recipeOverrides ?? {}) as Record<string, unknown>;
      const merged = { ...existing, ...parsedOverrides };

      // Clean: explicit null removes that key
      for (const [k, v] of Object.entries(merged)) {
        if (v === null) delete merged[k];
      }

      // Clean: if empty after merge, remove entirely
      if (Object.keys(merged).length === 0) {
        delete raw.recipeOverrides;
      } else {
        raw.recipeOverrides = merged;
      }
    }

    // Validate merged config before writing
    const validated = ConfigSchema.safeParse(raw);
    if (!validated.success) {
      const message = validated.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError(
        "invalid_input",
        `Invalid config after merge: ${message}`,
      );
    }

    // Write atomically
    await guardPath(configPath, root);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");

    resultOverrides = (raw.recipeOverrides as Record<string, unknown>) ?? null;
  });

  const data = { recipeOverrides: resultOverrides };
  if (format === "json") {
    return { output: JSON.stringify({ version: 1, data }, null, 2) };
  }

  if (resultOverrides === null) {
    return { output: "Recipe overrides cleared (using recipe defaults)." };
  }

  const lines = Object.entries(resultOverrides).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
  return { output: `Recipe overrides updated:\n${lines.join("\n")}` };
}

export async function handleConfigSetFederation(
  root: string,
  format: OutputFormat,
  options: { allowNodeWrites?: boolean },
): Promise<CommandResult> {
  if (options.allowNodeWrites === undefined) {
    return {
      output: format === "json"
        ? JSON.stringify({ version: 1, error: "Provide --allow-node-writes or --no-allow-node-writes" })
        : "Error: Provide --allow-node-writes or --no-allow-node-writes",
      errorCode: "invalid_input",
    };
  }

  let resultFederation: Record<string, unknown> | null = null;

  await withProjectLock(root, { strict: false }, async () => {
    const configPath = join(root, ".story", "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) throw new ProjectLoaderError("io_error", `Cannot read config: ${readResult.error.message}`, readResult.error);
    const raw = JSON.parse(readResult.content) as Record<string, unknown>;

    if (raw.type !== "orchestrator") {
      throw new ProjectLoaderError(
        "invalid_input",
        "set-federation is only available on orchestrator projects.",
      );
    }

    const existing = (raw.federation ?? {}) as Record<string, unknown>;
    raw.federation = { ...existing, allowNodeWrites: options.allowNodeWrites };

    const validated = ConfigSchema.safeParse(raw);
    if (!validated.success) {
      const message = validated.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError("invalid_input", `Invalid config after merge: ${message}`);
    }

    await guardPath(configPath, root);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");

    resultFederation = raw.federation as Record<string, unknown>;
  });

  if (format === "json") {
    return { output: JSON.stringify({ version: 1, data: { federation: resultFederation } }, null, 2) };
  }

  return {
    output: `Federation settings updated: allowNodeWrites = ${options.allowNodeWrites}`,
  };
}
