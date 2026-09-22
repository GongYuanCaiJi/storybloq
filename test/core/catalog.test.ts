import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The three Codex byte-review findings are all TOCTOU or serialization
 * defects, and two of them are only reachable if something happens BETWEEN two
 * syscalls. A fixture cannot arrange that from the outside, so `node:fs` is
 * wrapped with a pass-through that fires a hook on the specific call the
 * finding is about. Everything not hooked is the real implementation: this
 * controls the interleaving, it does not simulate the filesystem.
 */
const fsHooks = vi.hoisted(() => ({
  /** Fires before `lstatSync(path)` when `path` is the hooked path. */
  beforeLstat: null as ((path: string) => void) | null,
  /** Path the two hooks below watch for. */
  watch: null as string | null,
  /** Nth realpathSync call on `watch` to redirect, 1-based. */
  redirectRealpathOnCall: 0,
  redirectRealpathTo: null as string | null,
  realpathCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = {
    ...actual,
    lstatSync: ((p: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) => {
      if (fsHooks.beforeLstat !== null && String(p) === fsHooks.watch) {
        const hook = fsHooks.beforeLstat;
        fsHooks.beforeLstat = null; // one shot: the swap happens once, not on every retry
        hook(String(p));
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.lstatSync,
    realpathSync: (() => {
      const wrapped = ((p: Parameters<typeof actual.realpathSync>[0], ...rest: unknown[]) => {
        if (String(p) === fsHooks.watch) {
          fsHooks.realpathCalls += 1;
          if (fsHooks.realpathCalls === fsHooks.redirectRealpathOnCall && fsHooks.redirectRealpathTo !== null) {
            return fsHooks.redirectRealpathTo;
          }
        }
        return (actual.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
      }) as unknown as typeof actual.realpathSync;
      // `realpathSync.native` exists and readdir-safe may reach for it.
      (wrapped as unknown as Record<string, unknown>).native = actual.realpathSync.native;
      return wrapped;
    })(),
  };
  return { ...patched, default: patched };
});

function resetFsHooks(): void {
  fsHooks.beforeLstat = null;
  fsHooks.watch = null;
  fsHooks.redirectRealpathOnCall = 0;
  fsHooks.redirectRealpathTo = null;
  fsHooks.realpathCalls = 0;
}
import { z } from "zod";
import { defineCatalog, CatalogLoadError, CATALOG_MAX_BYTES, titleWords, TITLE_STOP_WORDS } from "../../src/core/catalog.js";
import { CapabilityCatalogSchema, type CapabilityCatalog } from "../../src/models/capability.js";
import { sanitizeDisplayPath, MAX_PROSE_LENGTH } from "../../src/core/display-text.js";
import { initProject } from "../../src/core/init.js";

const roots: string[] = [];
afterEach(() => {
  resetFsHooks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(withStory = true): string {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  roots.push(root);
  if (withStory) mkdirSync(join(root, ".story"), { recursive: true });
  return root;
}

const capabilities = defineCatalog<CapabilityCatalog>({
  file: "capabilities.json",
  key: "capabilities",
  schema: CapabilityCatalogSchema,
  empty: () => ({ version: 1, capabilities: [] }),
});

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cap-core",
    name: "Core",
    summary: "The core module does the core thing.",
    surfaces: {},
    entryPoints: ["src/core"],
    contract: "It does the core thing.",
    checkedAt: { sha: "3a768cb3", date: "2026-09-20" },
    status: "current",
    ...overrides,
  };
}

/** The fixture temp dir is itself under a symlink on macOS (/var -> /private/var). */
function realpathSyncOf(path: string): string {
  return realpathSync(path);
}

/** Every channel a refusal could carry bytes through, flattened into one string. */
function thrownTextOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    return [e.message, e.stack ?? "", e.cause === undefined ? "" : String(e.cause)].join("\n");
  }
  return "";
}

function writeCatalog(root: string, body: unknown): void {
  writeFileSync(join(root, ".story", "capabilities.json"), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

describe("catalog load: absence is not an error", () => {
  it("loads the schema-shaped empty document when .story/ does not exist", () => {
    const root = newRoot(false);
    const res = capabilities.load(root);
    expect(res.present).toBe(false);
    expect(res.doc).toEqual({ version: 1, capabilities: [] });
  });

  it("loads the schema-shaped empty document when the file does not exist", () => {
    const root = newRoot();
    const res = capabilities.load(root);
    expect(res.present).toBe(false);
    expect(res.doc.capabilities).toEqual([]);
  });

  it("loads a real document with present true", () => {
    const root = newRoot();
    writeCatalog(root, { version: 1, capabilities: [entry()] });
    const res = capabilities.load(root);
    expect(res.present).toBe(true);
    expect(res.doc.capabilities).toHaveLength(1);
    expect(res.doc.capabilities[0]!.id).toBe("cap-core");
  });
});

describe("catalog load: the three steps, each one closing a distinct wrong answer", () => {
  it("step 1: a DANGLING PARENT symlink is an error, not an empty catalog", () => {
    const root = newRoot(false);
    symlinkSync(join(root, "nowhere"), join(root, ".story"));
    // Without directory validation, lstat of .story/capabilities.json gives the
    // same ENOENT as a genuinely missing file, and a broken project would read
    // as a new one.
    expect(() => capabilities.load(root)).toThrow(CatalogLoadError);
    expect(() => capabilities.load(root)).toThrow(/symlink/);
  });

  it("step 1: a .story SYMLINK to a real directory is refused, matching every other loader", () => {
    const root = newRoot(false);
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "capabilities.json"), JSON.stringify({ version: 1, capabilities: [] }));
    symlinkSync(real, join(root, ".story"));
    expect(() => capabilities.load(root)).toThrow(/symlink/);
  });

  it("step 1: a .story that is a FILE is refused rather than read", () => {
    const root = newRoot(false);
    writeFileSync(join(root, ".story"), "not a directory");
    expect(() => capabilities.load(root)).toThrow(/not a directory/);
  });

  it("step 2: a DANGLING LEAF symlink is an error, not an absence", () => {
    const root = newRoot();
    symlinkSync(join(root, ".story", "nowhere.json"), join(root, ".story", "capabilities.json"));
    // realpath and existsSync both report this identically to a missing file.
    // Only lstat separates them, which is why the leaf is classified with lstat.
    expect(() => capabilities.load(root)).toThrow(CatalogLoadError);
    expect(() => capabilities.load(root)).toThrow(/symlink whose target could not be resolved/);
  });

  it("step 2: a legitimately symlinked catalog INSIDE .story still loads", () => {
    const root = newRoot();
    writeFileSync(join(root, ".story", "real.json"), JSON.stringify({ version: 1, capabilities: [entry()] }));
    symlinkSync(join(root, ".story", "real.json"), join(root, ".story", "capabilities.json"));
    // Following a symlink is documented intent in readBoundedFileDetailed, not
    // an oversight: a test that only pinned the refusal would invite someone to
    // "fix" this into a regression.
    const res = capabilities.load(root);
    expect(res.present).toBe(true);
    expect(res.doc.capabilities).toHaveLength(1);
  });

  it("step 3: a catalog symlinked OUTSIDE the project is refused before its bytes are used", () => {
    const root = newRoot();
    const outside = mkdtempSync(join(tmpdir(), "catalog-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "theirs.json"), JSON.stringify({ version: 1, capabilities: [entry()] }));
    symlinkSync(join(outside, "theirs.json"), join(root, ".story", "capabilities.json"));
    expect(() => capabilities.load(root)).toThrow(CatalogLoadError);
    expect(() => capabilities.load(root)).toThrow(/outside/);
  });
});

describe("catalog load: content", () => {
  it("refuses a zero-byte file and leaves its bytes alone (owner ruling r-8bjvtgh0hphetpw0)", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    writeCatalog(root, "");
    expect(() => capabilities.load(root)).toThrow(/empty or whitespace-only/);
    expect(statSync(path).size).toBe(0);
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  it("refuses a whitespace-only file for the same reason", () => {
    const root = newRoot();
    writeCatalog(root, "  \n\t\n  ");
    expect(() => capabilities.load(root)).toThrow(/empty or whitespace-only/);
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe("  \n\t\n  ");
  });

  it("refuses invalid JSON", () => {
    const root = newRoot();
    writeCatalog(root, "{ not json");
    expect(() => capabilities.load(root)).toThrow(/not valid JSON/);
  });

  it("refuses a document that does not match the schema", () => {
    const root = newRoot();
    writeCatalog(root, { version: 1, capabilities: [entry({ id: "not-a-cap-id" })] });
    expect(() => capabilities.load(root)).toThrow(/does not match the catalog schema/);
  });

  it("refuses a FUTURE version rather than passing it through to be rewritten", () => {
    const root = newRoot();
    writeCatalog(root, { version: 2, capabilities: [] });
    expect(() => capabilities.load(root)).toThrow(CatalogLoadError);
  });

  it("refuses a file over the byte bound before parsing it", () => {
    const root = newRoot();
    const filler = "x".repeat(CATALOG_MAX_BYTES + 1);
    writeCatalog(root, `{"version":1,"capabilities":[],"pad":"${filler}"}`);
    expect(() => capabilities.load(root)).toThrow(/larger than/);
  });

  it("keeps unknown fields through a load", () => {
    const root = newRoot();
    writeCatalog(root, { version: 1, capabilities: [entry({ futureField: 7 })], generatedBy: "cpm-a7" });
    const res = capabilities.load(root);
    expect((res.doc as Record<string, unknown>).generatedBy).toBe("cpm-a7");
    expect((res.doc.capabilities[0] as Record<string, unknown>).futureField).toBe(7);
  });
});

describe("catalog write", () => {
  it("refuses a serialized document over the bound and leaves the previous bytes intact", async () => {
    const root = newRoot();
    const previous = { version: 1 as const, capabilities: [entry()] };
    writeCatalog(root, previous);
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");

    const huge = {
      version: 1 as const,
      capabilities: [entry({ contract: "y".repeat(CATALOG_MAX_BYTES) })],
    } as unknown as CapabilityCatalog;
    await expect(capabilities.writeUnlocked(root, huge)).rejects.toThrow(/exceeds/);
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });

  it("writes a document that loads back identically", async () => {
    const root = newRoot();
    const doc = CapabilityCatalogSchema.parse({ version: 1, capabilities: [entry()] });
    await capabilities.writeUnlocked(root, doc);
    const res = capabilities.load(root);
    expect(res.present).toBe(true);
    expect(res.doc).toEqual(doc);
  });

  it("ends the file with a newline, so a ledger diff is not a no-newline-at-eof hunk", async () => {
    const root = newRoot();
    await capabilities.writeUnlocked(root, CapabilityCatalogSchema.parse({ version: 1, capabilities: [entry()] }));
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8").endsWith("}\n")).toBe(true);
  });
});

describe("catalog definition is generic", () => {
  it("instantiates for a second file and key without touching the first", () => {
    const TermCatalogSchema = z
      .object({ version: z.literal(1), terms: z.array(z.object({ id: z.string() })).default([]) })
      .passthrough();
    const glossary = defineCatalog({
      file: "glossary.json",
      key: "terms",
      schema: TermCatalogSchema,
      empty: () => ({ version: 1 as const, terms: [] }),
    });
    const root = newRoot();
    writeFileSync(join(root, ".story", "glossary.json"), JSON.stringify({ version: 1, terms: [{ id: "term-pen" }] }));
    writeCatalog(root, { version: 1, capabilities: [entry()] });

    expect(glossary.load(root).doc.terms).toHaveLength(1);
    expect(capabilities.load(root).doc.capabilities).toHaveLength(1);
    expect(glossary.file).toBe("glossary.json");
    expect(glossary.key).toBe("terms");
  });
});

describe("titleWords: the tokeniser both catalogs share", () => {
  it("lower-cases, splits on non-alphanumerics and de-duplicates", () => {
    expect(titleWords("Capability CHECK, capability check")).toEqual(["capability", "check"]);
  });

  it("drops words shorter than three characters, which are never discriminating", () => {
    expect(titleWords("a an id of the cap")).toEqual(["cap"]);
  });

  it("drops stop words, so a title built only from them tokenises to nothing", () => {
    expect(titleWords("Add the new set of all")).toEqual([]);
    for (const word of TITLE_STOP_WORDS) expect(titleWords(word)).toEqual([]);
  });

  it("does not stem: the singular and the plural are different tokens", () => {
    // A miss is recoverable by reading the inventory. A false match sends a
    // session to the wrong entry and is not, so the tokeniser errs toward
    // missing.
    expect(titleWords("ruling")).toEqual(["ruling"]);
    expect(titleWords("rulings")).toEqual(["rulings"]);
  });
});

/**
 * Codex byte-review finding 1. The leaf-ENOENT branch reported "no catalog"
 * about a directory it had stopped being able to vouch for. The rule the fix
 * encodes is general: any exit reporting a conclusion about the directory's
 * CONTENTS revalidates the directory first, and absence is such a conclusion.
 */
describe("finding 1: absence is only absence if the directory is still the validated one", () => {
  it("refuses when .story/ is REMOVED between the directory scan and the leaf classification", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    fsHooks.watch = path;
    fsHooks.beforeLstat = () => {
      rmSync(join(root, ".story"), { recursive: true, force: true });
    };
    // Before the fix this returned { present: false } with an empty catalog:
    // a clean answer about a directory that no longer existed.
    expect(() => capabilities.load(root)).toThrow(CatalogLoadError);
  });

  it("refuses when .story/ is SWAPPED for a different directory in the same window", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    fsHooks.watch = path;
    const original = statSync(join(root, ".story"));
    const seen: { impostor: { dev: number; ino: number } | null } = { impostor: null };
    fsHooks.beforeLstat = () => {
      // Renamed aside, not deleted: while the original is still alive its
      // inode cannot be reused, so the impostor is guaranteed a different
      // identity. A delete-then-recreate may get the same inode back, and the
      // test would then be exercising nothing.
      renameSync(join(root, ".story"), join(root, ".story-original"));
      mkdirSync(join(root, ".story"), { recursive: true });
      const st = statSync(join(root, ".story"));
      seen.impostor = { dev: st.dev, ino: st.ino };
    };
    // The impostor is a real, readable, empty directory, so every check that
    // asks "is this a valid .story?" passes. Only identity separates them.
    expect(() => capabilities.load(root)).toThrow(/\.story\//);
    expect(seen.impostor).not.toBeNull();
    expect([seen.impostor!.dev, seen.impostor!.ino]).not.toEqual([original.dev, original.ino]);
  });

  it("still reports a plain absence when the directory is untouched and only the file is missing", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    fsHooks.watch = path;
    let hookRan = false;
    fsHooks.beforeLstat = () => {
      hookRan = true; // installed, mutates nothing
    };
    const res = capabilities.load(root);
    // Proves the two tests above fail because of the SWAP rather than because
    // of the hook, and pins the behaviour the fix must not have broken: a
    // missing catalog in a healthy project is still not an error.
    expect(hookRan).toBe(true);
    expect(res.present).toBe(false);
    expect(res.doc).toEqual({ version: 1, capabilities: [] });
  });
});

/**
 * Codex byte-review finding 2. `verifyContainment` and the reader resolve the
 * pathname independently, so the check validated one resolution and the read
 * used another. The mitigation is partial by construction (see the comment in
 * catalog.ts and ISS-1275); what it does close is tested here.
 */
describe("finding 2: containment is checked on the path the reader actually resolved", () => {
  it("refuses when the leaf resolves INSIDE for the containment check and OUTSIDE for the read", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    writeCatalog(root, { version: 1, capabilities: [] });

    const outside = mkdtempSync(join(tmpdir(), "catalog-outside-"));
    roots.push(outside);
    const theirs = join(outside, "theirs.json");
    writeFileSync(theirs, JSON.stringify({ version: 1, capabilities: [entry()] }));

    // Call 1 on this path is verifyContainment's realpathSync(full) and sees
    // the real inside file, so containment PASSES. Call 2 is the reader's, and
    // is the swap: the reader opens and returns the outside file.
    fsHooks.watch = path;
    fsHooks.redirectRealpathOnCall = 2;
    fsHooks.redirectRealpathTo = realpathSyncOf(theirs);

    // ONE load. The redirect is armed on the Nth realpath call, and the
    // counter does not reset between loads, so a second call here would run
    // with a stale index and silently not be the case under test.
    let caught: unknown;
    try {
      capabilities.load(root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogLoadError);
    // The whole clause, not just the word: the refusal has to say what became
    // of the bytes, and by this point the reader has already read them. "it
    // was not read" would be a false account of a security-relevant event.
    expect((caught as Error).message).toContain("which is outside .story/; its bytes were discarded unparsed");
  });

  it("does not put the outside file's BYTES into the refusal, only its path", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    writeCatalog(root, { version: 1, capabilities: [] });

    const outside = mkdtempSync(join(tmpdir(), "catalog-outside-"));
    roots.push(outside);
    const secret = join(outside, "secret.json");
    const SENTINEL = "SENTINEL-4f1c9a-DO-NOT-DISCLOSE";
    // MALFORMED on purpose. Well-formed outside bytes would be refused for
    // containment whether the check ran before or after the parse, so they
    // could not tell the two orderings apart; these can only be parsed into a
    // diagnostic, so the parse-first ordering shows up as a different refusal.
    writeFileSync(secret, `{ "version": 1, "note": "${SENTINEL}", `);

    fsHooks.watch = path;
    fsHooks.redirectRealpathOnCall = 2;
    fsHooks.redirectRealpathTo = realpathSyncOf(secret);

    // The refusal must run BEFORE the parse. If it ran after, a malformed
    // outside file would reach the JSON diagnostic, which is the exfil path.
    // One capture, for the same reason as the test above, and `toContain` on
    // an empty string passes, so the refusal is asserted first rather than
    // letting a no-throw read as a clean result.
    const text = thrownTextOf(() => capabilities.load(root));
    expect(text).toMatch(/outside/);
    expect(text).not.toContain(SENTINEL);
    expect(text, "the parse must not have run: this is the containment refusal, not the JSON diagnostic").not.toContain("is not valid JSON");
  });

  it("names an outside target in the reversible path form, whatever its directory is called", () => {
    const root = newRoot();
    const path = join(root, ".story", "capabilities.json");
    writeCatalog(root, { version: 1, capabilities: [] });

    const outside = mkdtempSync(join(tmpdir(), "catalog-out\u001b[31m\u202e-"));
    roots.push(outside);
    const theirs = join(outside, "theirs.json");
    writeFileSync(theirs, JSON.stringify({ version: 1, capabilities: [] }));

    fsHooks.watch = path;
    fsHooks.redirectRealpathOnCall = 2;
    fsHooks.redirectRealpathTo = realpathSyncOf(theirs);

    const text = thrownTextOf(() => capabilities.load(root));
    expect(text).toContain("catalog-out\\u001b[31m\\u202e-");
    expect(text).toContain("(rendered with");
    // The message is the first line; the stack that follows is joined on newlines.
    expect(text.split("\n")[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  });

  it("accepts a target that resolves inside, so the check is containment and not a blanket refusal", () => {
    const root = newRoot();
    writeFileSync(join(root, ".story", "real.json"), JSON.stringify({ version: 1, capabilities: [entry()] }));
    symlinkSync(join(root, ".story", "real.json"), join(root, ".story", "capabilities.json"));
    expect(capabilities.load(root).doc.capabilities).toHaveLength(1);
  });
});

/**
 * The invalid-JSON diagnostic carries no content. The ancestor-replacement
 * race in ISS-1275 is by construction a case the containment checks do not
 * catch, so the only mitigation that reaches it is removing the channel
 * instead of guarding the door.
 */
describe("a catalog error is printed, so its message is sanitized whatever built it", () => {
  it("marks every control, line-separator and bidi character in the reason", () => {
    const err = new CatalogLoadError("capabilities.json", "a\u001b[31mb\rc\u202ed\u2028e\u009bf");
    expect(err.message).toBe("capabilities.json: a?[31mb?c?d?e?f");
  });

  it("leaves a path this module already encoded intact at any length, so it still decodes to the name on disk", () => {
    // The longest raw path the path form keeps whole, mixing every kind of character it encodes.
    const unit = "dir\u001b[31m\u202e\\x\u2028\u009b\u{e0041}/";
    const raw = unit.repeat(Math.ceil(4096 / unit.length)).slice(0, 4096);
    const encoded = sanitizeDisplayPath(raw);
    expect(encoded.length).toBeGreaterThan(4000);
    const err = new CatalogLoadError("capabilities.json", `resolved to ${encoded}, which is outside .story/; its bytes were discarded unparsed`);
    expect(err.message).toBe(`capabilities.json: resolved to ${encoded}, which is outside .story/; its bytes were discarded unparsed`);
    const shown = err.message.slice("capabilities.json: resolved to ".length).split("  (rendered with")[0]!;
    const decoded = shown.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\\\/g, (m, astral, bmp) =>
      astral ? String.fromCodePoint(parseInt(astral, 16)) : bmp ? String.fromCharCode(parseInt(bmp, 16)) : "\\",
    );
    expect(decoded).toBe(raw);
  });
});

describe("a refused write caps the caller's own value it echoes, and says how much it cut", () => {
  const long = "src/" + "a".repeat(9000);
  const doc = { version: 1, capabilities: [entry({ entryPoints: [long, long] })] } as unknown as CapabilityCatalog;
  const full = (): string => CapabilityCatalogSchema.safeParse(doc).error!.issues[0]!.message;
  const capped = (): string => `${full().slice(0, 4000)}... (${full().length - 4000} more characters)`;

  it("in the write that validates the bytes", async () => {
    expect(full()).toContain(long);
    const root = newRoot();
    await expect(capabilities.writeUnlocked(root, doc)).rejects.toThrow(
      `capabilities.json: refusing to write a document the read path would reject: ${capped()}; nothing was written`,
    );
  });

  it("in the re-validation of the serialized bytes", async () => {
    const root = newRoot();
    const valid = { version: 1, capabilities: [entry()], toJSON: () => doc } as unknown as CapabilityCatalog;
    expect(CapabilityCatalogSchema.safeParse(valid).success).toBe(true);
    await expect(capabilities.writeUnlocked(root, valid)).rejects.toThrow(
      `capabilities.json: serialized to bytes the read path would reject: ${capped()}; nothing was written`,
    );
  });

  it("in the message a throwing toJSON produced", async () => {
    // The other rows echo a zod message; this one echoes an Error the CALLER
    // threw, which is the same unbounded value from a different direction.
    const root = newRoot();
    const boom = "boom " + "z".repeat(9000);
    const doc2 = {
      version: 1,
      capabilities: [entry()],
      toJSON: () => {
        throw new Error(boom);
      },
    } as unknown as CapabilityCatalog;
    const cut = `${boom.slice(0, 4000)}... (${boom.length - 4000} more characters)`;
    await expect(capabilities.writeUnlocked(root, doc2)).rejects.toThrow(`capabilities.json: could not be serialized (${cut}); nothing was written`);
  });

  it("in a mutation", async () => {
    // A mutation takes the project lock, which needs a real project.
    const root = newRoot(false);
    await initProject(root, { name: "Echo", type: "npm" });
    await expect(capabilities.mutate(root, () => doc)).rejects.toThrow(`capabilities.json: refusing to write an invalid document: ${capped()}`);
  });
});

describe("the invalid-JSON diagnostic discloses nothing about the bytes", () => {
  const SENTINEL = "SENTINEL-9b3e77-AKIAIOSFODNN7EXAMPLE";

  it("names no fragment of the input, no parser message and no offset", () => {
    const root = newRoot();
    writeCatalog(root, `{"version":1,"secret":"${SENTINEL}",`);
    const text = thrownTextOf(() => capabilities.load(root));
    expect(text).toContain("is not valid JSON");
    expect(text).not.toContain(SENTINEL);
    // The parser's own message quotes the input. Asserting the sentinel alone
    // would still pass if a future edit reinstated a message that happened not
    // to quote this particular byte range, so the shape is pinned too.
    expect(text).not.toMatch(/position|token|JSON at/i);
  });

  it("carries no `cause` chain that would smuggle the parser error back in", () => {
    const root = newRoot();
    writeCatalog(root, `{${SENTINEL}`);
    let caught: unknown;
    try {
      capabilities.load(root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogLoadError);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify({ m: (caught as Error).message, s: (caught as Error).stack })).not.toContain(SENTINEL);
  });
});

/**
 * Codex byte-review finding 3. Validation happens on the OBJECT; the file
 * receives its SERIALIZATION. The question every check in `writeUnlocked` asks
 * is the same one: can the bytes I am about to write be loaded back?
 */
describe("finding 3: the write path validates the bytes, not just the object", () => {
  it("refuses a document that is type-correct but would fail the read path, and writes nothing", async () => {
    const root = newRoot();
    const previous = { version: 1 as const, capabilities: [entry()] };
    writeCatalog(root, previous);
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");

    // `writeUnlocked` is public and reachable by callers that already hold the
    // lock, so it cannot assume `transact` validated first.
    const bad = { version: 1, capabilities: [entry({ entryPoints: [] })] } as unknown as CapabilityCatalog;
    await expect(capabilities.writeUnlocked(root, bad)).rejects.toThrow(/nothing was written/);
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });

  it("refuses a schema-VALID document whose toJSON serializes to something the read path rejects", async () => {
    const root = newRoot();
    const previous = { version: 1 as const, capabilities: [entry()] };
    writeCatalog(root, previous);
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");

    // `.passthrough()` keeps unknown keys, including a top-level `toJSON`, and
    // `JSON.stringify` calls it. The object parses clean and the bytes are
    // `{"version":2}`, which `load` refuses as a future version.
    const doc = {
      version: 1,
      capabilities: [entry()],
      toJSON: () => ({ version: 2 }),
    } as unknown as CapabilityCatalog;
    expect(CapabilityCatalogSchema.safeParse(doc).success).toBe(true);
    expect(JSON.stringify(doc)).toBe('{"version":2}');

    await expect(capabilities.writeUnlocked(root, doc)).rejects.toThrow(/serialized to bytes the read path would reject/);
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });

  it("refuses a toJSON whose substitute is itself schema-valid, which the read-path check alone would let through", async () => {
    const root = newRoot();
    const previous = { version: 1 as const, capabilities: [entry()] };
    writeCatalog(root, previous);
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");

    // The substitute loads: it is a well-formed catalog, just not the one the
    // caller wrote. Round-tripping the bytes through the schema therefore says
    // yes, and only comparing them against the document says no.
    const substitute = { version: 1, capabilities: [entry({ id: "cap-substituted" })] };
    const doc = {
      version: 1,
      capabilities: [entry({ id: "cap-requested" })],
      toJSON: () => substitute,
    } as unknown as CapabilityCatalog;
    expect(CapabilityCatalogSchema.safeParse(doc).success).toBe(true);
    expect(CapabilityCatalogSchema.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(true);

    await expect(capabilities.writeUnlocked(root, doc)).rejects.toThrow(
      "capabilities.json: serialized to bytes that are not this document (a toJSON substituted it); nothing was written",
    );
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });

  it("still writes a document whose optional key is present and undefined, which serialization drops", async () => {
    const root = newRoot();
    // An optional field written as `undefined` survives the parse as a key
    // that is PRESENT and undefined (Zod keeps a key the input had), and
    // `JSON.stringify` then drops it. That is a drop, not a substitution, and
    // the comparison above must not turn it into a refusal.
    const doc = { version: 1, capabilities: [entry({ rulings: undefined })] } as unknown as CapabilityCatalog;
    const parsed = CapabilityCatalogSchema.parse(doc) as unknown as { capabilities: Array<Record<string, unknown>> };
    expect("rulings" in parsed.capabilities[0]!).toBe(true);
    expect(parsed.capabilities[0]!.rulings).toBeUndefined();

    await capabilities.writeUnlocked(root, doc);
    const written = capabilities.load(root);
    expect(written.present).toBe(true);
    expect(written.doc.capabilities).toHaveLength(1);
  });

  it("refuses a toJSON that MUTATES the document before returning its substitute", async () => {
    const root = newRoot();
    const previous = { version: 1 as const, capabilities: [entry()] };
    writeCatalog(root, previous);
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");

    // The nastier shape of the same substitution. `stringify` is what RUNS a
    // toJSON, so a comparison snapshot taken afterwards is taken from a
    // document this method has already emptied, and matches the substitute it
    // returned. Only a snapshot taken BEFORE serialization still holds the
    // entries the caller asked to write.
    // Built fresh per use on purpose: this toJSON is single-shot, so a probe
    // that serializes it would empty the very document the write is meant to
    // receive, and the test would pass for the wrong reason.
    const makeDoc = () =>
      ({
        version: 1,
        capabilities: [entry({ id: "cap-requested" })],
        toJSON(this: { capabilities: unknown[] }) {
          this.capabilities = [];
          return { version: 1, capabilities: [] };
        },
      }) as unknown as CapabilityCatalog;
    expect(CapabilityCatalogSchema.safeParse(JSON.parse(JSON.stringify(makeDoc()))).success).toBe(true);

    await expect(capabilities.writeUnlocked(root, makeDoc())).rejects.toThrow(
      "capabilities.json: serialized to bytes that are not this document (a toJSON substituted it); nothing was written",
    );
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });

  it("still writes a document that reaches one object by two paths", async () => {
    const root = newRoot();
    // `shared` is reachable as both `a` and `b`. Memoising visited objects to
    // survive a cycle must hand back the PROJECTED counterpart on the second
    // visit, not the raw object: serialization drops `x` under both keys, so
    // returning it unprojected once would fail the comparison and refuse a
    // document that has no toJSON at all.
    const shared = { x: undefined };
    const doc = { version: 1, capabilities: [entry()], a: shared, b: shared } as unknown as CapabilityCatalog;

    await capabilities.writeUnlocked(root, doc);
    const stored = JSON.parse(readFileSync(join(root, ".story", "capabilities.json"), "utf-8"));
    expect(stored.a).toEqual({});
    expect(stored.b).toEqual({});
  });

  it("still writes a document carrying the values JSON has no syntax for", async () => {
    const root = newRoot();
    // A non-finite number and an array hole are both NORMALISED by
    // serialization, to `null` in either case. Like a drop, that is not a
    // substitution, and the comparison must not read it as one.
    const doc = {
      version: 1,
      capabilities: [entry()],
      nonFinite: [Infinity, -Infinity, NaN],
      // eslint-disable-next-line no-sparse-arrays
      sparse: [, 1],
      negativeZero: -0,
    } as unknown as CapabilityCatalog;

    await capabilities.writeUnlocked(root, doc);
    const stored = JSON.parse(readFileSync(join(root, ".story", "capabilities.json"), "utf-8"));
    expect(stored.nonFinite).toEqual([null, null, null]);
    expect(stored.sparse).toEqual([null, 1]);
    expect(stored.negativeZero).toBe(0);
  });

  it("does not follow an array that grows while it is being read", async () => {
    const root = newRoot();
    let reads = 0;
    const growing: unknown[] = [];
    // Each read installs the NEXT index, so the array extends behind whatever
    // is walking it. Bounded at 50 so a runaway walk finishes and fails an
    // assertion instead of hanging the suite.
    const install = (index: number) => {
      Object.defineProperty(growing, index, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          if (growing.length < 50) install(growing.length);
          return 0;
        },
      });
    };
    install(0);
    const doc = { version: 1, capabilities: [entry()], growing } as unknown as CapabilityCatalog;

    // `stringify` reads an array's length once, before it walks. A projection
    // re-reading `length` every iteration would chase each index installed
    // behind it. The write is refused either way, because the array is not the
    // same on the second read, but it must be refused after a BOUNDED walk.
    await expect(capabilities.writeUnlocked(root, doc)).rejects.toThrow(/nothing was written/);
    expect(reads).toBeLessThan(10);
    expect(capabilities.load(root).present).toBe(false);
  });

  it("caps the message a throwing getter produces, like any other failure to serialize", async () => {
    const root = newRoot();
    const long = "E".repeat(MAX_PROSE_LENGTH + 120);
    const doc = {
      version: 1,
      capabilities: [entry()],
      meta: {
        get boom(): never {
          throw new Error(long);
        },
      },
    } as unknown as CapabilityCatalog;

    // The projection reads the document the same way serialization does, so it
    // reaches an enumerable getter FIRST. That is still a failure to
    // serialize, and the caller's unbounded message has to come back capped
    // rather than propagate raw.
    const caught = await capabilities.writeUnlocked(root, doc).catch((err: unknown) => err);
    expect((caught as Error).message).toContain("could not be serialized");
    expect((caught as Error).message).toContain("... (120 more characters)");
    expect((caught as Error).message).toContain("nothing was written");
    expect(capabilities.load(root).present).toBe(false);
  });

  it("refuses a toJSON that throws rather than leaving a partial file", async () => {
    const root = newRoot();
    const doc = {
      version: 1,
      capabilities: [entry()],
      toJSON: () => {
        throw new Error("no");
      },
    } as unknown as CapabilityCatalog;
    await expect(capabilities.writeUnlocked(root, doc)).rejects.toThrow(/nothing was written/);
    expect(capabilities.load(root).present).toBe(false);
  });
});

/**
 * The schema diagnostic is the SECOND value-bearing channel in this loader.
 * Zod's `invalid_enum_value` message renders the rejected value verbatim, so
 * it is the same primitive as the parser message, narrower but not different
 * in kind. It gets a different answer rather than the same one, because the
 * location is the whole diagnostic on a path users hit while hand-editing.
 */
describe("the schema diagnostic gives a location, never a value", () => {
  it("names WHERE the document failed and the Zod issue code", () => {
    const root = newRoot();
    writeCatalog(root, { version: 1, capabilities: [entry({ status: "current" }), entry({ id: "cap-two", status: "nope" })] });
    const text = thrownTextOf(() => capabilities.load(root));
    expect(text).toContain("capabilities.1.status");
    expect(text).toContain("invalid_enum_value");
  });

  it("does not render the rejected VALUE, which is what the Zod message would do", () => {
    const root = newRoot();
    const SENTINEL = "SENTINEL-c17a20-VALUE";
    writeCatalog(root, { version: 1, capabilities: [entry({ status: SENTINEL })] });
    const text = thrownTextOf(() => capabilities.load(root));
    expect(text).toContain("capabilities.0.status");
    expect(text).not.toContain(SENTINEL);
  });

  it("redacts a path segment that came from the INPUT rather than from our schema", () => {
    // The capability schema is fixed-shape, so its every legitimate path
    // segment is a schema key and the filter is a no-op there. A schema with a
    // record is what makes an input-derived segment reachable at all, and the
    // filter has to already be correct on the day someone adds one.
    const RecordCatalogSchema = z
      .object({
        version: z.literal(1),
        items: z.record(z.object({ n: z.number() })).default({}),
      })
      .passthrough();
    const records = defineCatalog({
      file: "records.json",
      key: "items",
      schema: RecordCatalogSchema,
      empty: () => ({ version: 1 as const, items: {} }),
    });

    const root = newRoot();
    const SENTINEL = "SENTINEL-8e44f1-KEY-NAME";
    writeFileSync(
      join(root, ".story", "records.json"),
      JSON.stringify({ version: 1, items: { [SENTINEL]: { n: "not a number" } } }),
    );
    const text = thrownTextOf(() => records.load(root));
    expect(text).not.toContain(SENTINEL);
    // The segments that DID come from our own source code survive, so the
    // redaction is targeted rather than a fixed string by another name.
    expect(text).toContain("items.<redacted>.n");
  });
});
