import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { formatHookCommand, parseHookCommand } from "../src/core/hook-migration.js";

describe("formatHookCommand / parseHookCommand round-trip", () => {
  const subcommand = "session compact-prepare";

  const paths = [
    "/usr/local/bin/storybloq",
    "/simple/path",
    "/path/with spaces/bin",
    "/path/with  double  spaces/bin",
    "/path/with\ttab/bin",
    "/path/ending-in-apostrophe'",
    "/path/it's/a/bin",
    "/path/it's/got/'quotes'/bin",
    "/path/with\"doublequotes\"/bin",
    "/path/with\\backslash/bin",
    "/path/with\\\\double\\\\backslash/bin",
    "/path/with #hash/bin",
    "/path/with ~tilde/bin",
    "/path/with [brackets]/bin",
    "/path/with {braces}/bin",
    "/path/with *glob/bin",
    "/path/with ?question/bin",
    "/path/with !bang/bin",
    "/home/user/my app's dir/storybloq",
    "/path/with spaces and 'quotes'/storybloq",
    "simple-no-dir",
    "/a/b/c",
    "/path/with\\back and spaces/bin",
    "/path/'",
  ];

  for (const binPath of paths) {
    it(`round-trips: ${JSON.stringify(binPath)}`, () => {
      const formatted = formatHookCommand(binPath, subcommand);
      const parsed = parseHookCommand(formatted);
      expect(parsed).not.toBeNull();
      expect(parsed!.binBasename).toBe(basename(binPath));
      expect(parsed!.rest).toBe(subcommand);
    });
  }
});
