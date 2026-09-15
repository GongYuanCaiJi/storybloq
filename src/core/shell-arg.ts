/**
 * T-509: one formatter for every dynamic argument that is DISPLAYED as part of
 * a command the user is expected to paste, or passed through a shell on win32.
 * Bare-safe tokens stay as they are so ordinary paths read naturally.
 *
 * cmd.exe expands `%NAME%` (and `!NAME!` under delayed expansion) even inside
 * double quotes and offers no escape for either on a command line, so a value
 * containing `%` or `!` cannot be made safe for a win32 shell launch;
 * `winShellArgv` refuses such an argv and the caller reports it instead.
 */
const SAFE_POSIX = /^[A-Za-z0-9_\-./:@%+=,~]+$/;
const SAFE_WIN32 = /^[A-Za-z0-9_\-./:@+=,~\\]+$/;

export function shellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  // A leading tilde would expand; a leading hyphen is a flag and reads as one.
  if (value.length > 0 && (win ? SAFE_WIN32 : SAFE_POSIX).test(value) && !value.startsWith("~")) return value;
  if (win) return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** True when cmd.exe could rewrite the value through variable expansion. */
export function cmdExpands(value: string): boolean {
  return value.includes("%") || value.includes("!");
}

/**
 * The argv to hand a win32 shell launch (`shell: true`, needed for npm .cmd
 * shims), or null when any argument could be expanded by cmd.exe.
 */
export function winShellArgv(args: readonly string[]): string[] | null {
  if (args.some(cmdExpands)) return null;
  return args.map((a) => shellArg(a, "win32"));
}
