#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/ruling-labels.json` (T-528): the section titles,
 * lifecycle names, resolution kinds, "current" label and attribution caveat the
 * Mac app shows beside the decisions projection, exported from the functions
 * the CLI renders them with. Hand-editing the output is pointless: a drift test
 * regenerates it in memory and compares.
 *
 * Usage:
 *   tsx scripts/export-labels.ts            # write the file
 *   tsx scripts/export-labels.ts --stdout   # print it
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeRulingLabels } from "../src/core/decisions-labels.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LABELS_OUT = join(pkgRoot, "test", "fixtures", "ruling-labels.json");

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const output = serializeRulingLabels();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(output);
  } else {
    writeFileSync(LABELS_OUT, output);
    process.stderr.write(`wrote ${LABELS_OUT}\n`);
  }
}
