import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: { cli: "src/cli/index.ts", index: "src/index.ts", mcp: "src/mcp/index.ts" },
  dts: true,
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  shims: true,
  define: {
    "process.env.STORYBLOQ_VERSION": JSON.stringify(pkg.version),
  },
});
