/**
 * T-526 (plan D4): the `ledger` surface. One command today, `ledger restore`,
 * for the single-record files a catalog command does not own: rulings, notes
 * and issues. Capability entries and terms restore through their own
 * surfaces; all three share `restoreCommand` and the core in
 * `core/ledger-restore.ts`.
 */

import { restoreCommand, type RestoreInput } from "./capability.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/** Restore one ruling, note or issue file to its bytes at `--from`, if it still matches `--expect`. */
export async function handleLedgerRestore(input: RestoreInput & { readonly path: string }, format: OutputFormat, root: string): Promise<CommandResult> {
  return restoreCommand({ kind: "record", path: input.path }, input, format, root);
}
