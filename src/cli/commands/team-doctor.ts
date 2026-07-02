import { runDoctor, type DoctorContext } from "../../core/team-doctor.js";
import { formatDoctorResult, ExitCode } from "../../core/output-formatter.js";
import { withProjectLock } from "../../core/project-loader.js";
import { isTeamModeConfig, currentCliVersion } from "../../core/team-capabilities.js";
import type { CommandResult } from "../types.js";

export interface TeamDoctorOptions {
  readonly ci: boolean;
  readonly format: "md" | "json";
}

export async function handleTeamDoctor(
  root: string,
  options: TeamDoctorOptions,
): Promise<CommandResult> {
  let output = "";
  let exitCode: number = ExitCode.OK;

  await withProjectLock(root, { strict: false }, async ({ state, warnings }) => {
    const ctx: DoctorContext = {
      root,
      // ISS-748: the JSON named-import this replaced was undefined in dist builds
      // (esbuild-inlined JSON modules export only default), silently disabling
      // checkCliVersion in every bundled build.
      cliVersion: currentCliVersion(),
      isTeamMode: isTeamModeConfig(state.config),
      loadWarnings: warnings,
    };

    const result = await runDoctor(state, ctx);
    output = formatDoctorResult(result, options.format);

    if (options.ci && result.errorCount > 0) {
      exitCode = 1;
    }
  });

  return { output, exitCode };
}
