import { spawnWorker, type SpawnWorkerOptions } from "../../core/duet-spawn.js";
import { ExitCode } from "../../core/output-formatter.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/** `storybloq duet spawn` (N-131): start a visible worker session from the pen. */
export function handleDuetSpawn(args: SpawnWorkerOptions, format: OutputFormat, root: string): CommandResult {
  const result = spawnWorker(root, args);
  if (format === "json") {
    return { output: JSON.stringify({ version: 1, data: result }, null, 2), exitCode: ExitCode.OK };
  }
  const lines = [
    result.launch === "opened"
      ? `Opened worker "${result.name}" in a new terminal window (${result.launcher}).`
      : `Worker "${result.name}" is ready to start. Paste this in a terminal:`,
    "",
    "    " + result.command,
    "",
    `Permission mode: ${result.permissionMode} (${result.permissionModeSource === "explicit" ? "as given" : result.permissionModeSource === "inherited-bypass" ? "inherited: the pen runs in bypass" : "product default; the pen is not in bypass"})`,
    `Role: ${result.rolePath}`,
    `Script: ${result.scriptPath}`,
    "",
    `Once the session is up, type /story in it, then handshake by name from the pen (${args.pen}): project, both identities, coordination session id, nonce.`,
  ];
  return { output: lines.join("\n"), exitCode: ExitCode.OK };
}
