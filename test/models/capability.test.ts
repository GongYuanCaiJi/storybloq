import { describe, it, expect } from "vitest";
import {
  CapabilitySchema,
  CapabilityCatalogSchema,
  EntryPointSchema,
  CATALOG_SLUG_REGEX,
  CapabilityIdSchema,
  TermIdSchema,
} from "../../src/models/capability.js";

function baseCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: "cap-rulings",
    name: "Rulings",
    summary: "Record an attributed decision and cite it from a ticket.",
    entryPoints: ["src/core/ruling.ts", "src/cli/commands/ruling.ts"],
    contract: "A ruling is verbatim and attributed. Citing a superseded ruling resolves forward to its successor.",
    checkedAt: { sha: "3a768cb3", date: "2026-09-20" },
    ...overrides,
  };
}

describe("CapabilitySchema", () => {
  it("parses a well-formed entry and applies both defaults", () => {
    const result = CapabilitySchema.safeParse(baseCapability());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("current");
    expect(result.data.surfaces).toEqual({});
  });

  it("round trips through JSON without losing or inventing a field", () => {
    const input = baseCapability({
      status: "review",
      surfaces: { cli: ["ruling create"], mcp: ["storybloq_ruling_create"], app: [], files: [".story/rulings/"] },
      example: "storybloq ruling create --text '...'",
      rulings: ["r-8bjvtgh0hphetpw0"],
      items: ["T-476", "ISS-1126", "i-0123456789abcdef"],
      terms: ["term-ruling"],
    });
    const parsed = CapabilitySchema.parse(input);
    // Against the INPUT as well: comparing two parses alone passes a schema that
    // drops or invents a field on every parse, since both sides then agree.
    expect(parsed).toEqual(input);
    const reparsed = CapabilitySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("keeps unknown fields through a parse and rewrite (passthrough)", () => {
    const parsed = CapabilitySchema.parse(baseCapability({ futureField: { nested: 1 }, owner: "cpm-a7" }));
    expect((parsed as Record<string, unknown>).futureField).toEqual({ nested: 1 });
    const rewritten = CapabilitySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect((rewritten as Record<string, unknown>).owner).toBe("cpm-a7");
  });

  it("accepts both stored statuses and rejects any third value", () => {
    expect(CapabilitySchema.safeParse(baseCapability({ status: "current" })).success).toBe(true);
    expect(CapabilitySchema.safeParse(baseCapability({ status: "review" })).success).toBe(true);
    expect(CapabilitySchema.safeParse(baseCapability({ status: "stale" })).success).toBe(false);
  });

  describe("ids", () => {
    it("accepts a cap- id whose slug is legal", () => {
      for (const id of ["cap-a", "cap-team-mode", "cap-9", "cap-" + "a".repeat(48)]) {
        expect(CapabilitySchema.safeParse(baseCapability({ id })).success, id).toBe(true);
      }
    });

    it("rejects a missing prefix, a wrong prefix, an empty slug and an over-long slug", () => {
      for (const id of ["rulings", "term-rulings", "cap-", "cap-" + "a".repeat(49)]) {
        expect(CapabilitySchema.safeParse(baseCapability({ id })).success, id).toBe(false);
      }
    });

    it("rejects slug characters outside [a-z0-9-]", () => {
      for (const id of ["cap-Rulings", "cap-rul_ings", "cap-rul.ings", "cap-rul ings", "cap-rulings/x"]) {
        expect(CapabilitySchema.safeParse(baseCapability({ id })).success, id).toBe(false);
      }
    });

    it("derives the prefixed patterns from one slug pattern, so a cap- and a term- id agree with it on every slug", () => {
      const slugs = ["a", "team-mode", "9", "a".repeat(48), "a".repeat(49), "", "Team", "rul_ings", "rul.ings", "rul ings", "a/b", "\u00e9"];
      for (const slug of slugs) {
        const legal = CATALOG_SLUG_REGEX.test(slug);
        expect(CapabilityIdSchema.safeParse(`cap-${slug}`).success, `cap-${slug}`).toBe(legal);
        expect(TermIdSchema.safeParse(`term-${slug}`).success, `term-${slug}`).toBe(legal);
      }
      // Both sides of the table are populated, so agreement is not agreement on "always" or "never".
      expect(slugs.filter((slug) => CATALOG_SLUG_REGEX.test(slug))).toEqual(["a", "team-mode", "9", "a".repeat(48)]);
    });

    it("accepts a term- id in terms and rejects a cap- id there", () => {
      expect(CapabilitySchema.safeParse(baseCapability({ terms: ["term-pen"] })).success).toBe(true);
      expect(CapabilitySchema.safeParse(baseCapability({ terms: ["cap-pen"] })).success).toBe(false);
    });

    it("accepts ticket and issue refs in either canonical form and rejects anything else", () => {
      const ok = ["T-523", "T-523a", "t-qnja385m9qmnc5ak", "ISS-1107", "i-0123456789abcdef"];
      expect(CapabilitySchema.safeParse(baseCapability({ items: ok })).success).toBe(true);
      for (const bad of ["N-102", "L-099", "r-8bjvtgh0hphetpw0", "523", "T-"]) {
        expect(CapabilitySchema.safeParse(baseCapability({ items: [bad] })).success, bad).toBe(false);
      }
    });

    it("requires a ruling ref to be a canonical r- id", () => {
      expect(CapabilitySchema.safeParse(baseCapability({ rulings: ["r-8bjvtgh0hphetpw0"] })).success).toBe(true);
      expect(CapabilitySchema.safeParse(baseCapability({ rulings: ["R5"] })).success).toBe(false);
    });
  });

  describe("entry point paths", () => {
    it("accepts a repo-relative file and directory", () => {
      expect(EntryPointSchema.parse("src/core/ruling.ts")).toBe("src/core/ruling.ts");
      expect(EntryPointSchema.parse("src/core")).toBe("src/core");
    });

    it("normalises trailing slashes away, including repeated ones", () => {
      expect(EntryPointSchema.parse("src/core/")).toBe("src/core");
      expect(EntryPointSchema.parse("src/core///")).toBe("src/core");
    });

    it("rejects an empty path as empty, and a bare slash as ABSOLUTE: the leading slash survives normalization", () => {
      const message = (v: string): string => {
        const res = EntryPointSchema.safeParse(v);
        return res.success ? "(accepted)" : res.error.issues[0]!.message;
      };
      expect(message("")).toMatch(/cannot be empty/);
      expect(message("/")).toMatch(/repo-relative, not absolute/);
      expect(message("///")).toMatch(/repo-relative, not absolute/);
    });

    it("rejects an absolute path", () => {
      expect(EntryPointSchema.safeParse("/etc/passwd").success).toBe(false);
      expect(EntryPointSchema.safeParse("/src/core/ruling.ts").success).toBe(false);
    });

    it("rejects a `..` SEGMENT but not a filename that merely contains two dots", () => {
      expect(EntryPointSchema.safeParse("..").success).toBe(false);
      expect(EntryPointSchema.safeParse("../etc").success).toBe(false);
      expect(EntryPointSchema.safeParse("src/../etc").success).toBe(false);
      expect(EntryPointSchema.safeParse("src/core/..").success).toBe(false);
      expect(EntryPointSchema.parse("src/core/a..b.ts")).toBe("src/core/a..b.ts");
      expect(EntryPointSchema.parse("src/..core/x.ts")).toBe("src/..core/x.ts");
    });

    it("normalises inside a parsed entry, so the stored path is the checked path", () => {
      const parsed = CapabilitySchema.parse(baseCapability({ entryPoints: ["src/core/", "src/cli"] }));
      expect(parsed.entryPoints).toEqual(["src/core", "src/cli"]);
    });

    it("rejects the whole entry when any one entry point is illegal", () => {
      const result = CapabilitySchema.safeParse(baseCapability({ entryPoints: ["src/core", "../outside"] }));
      expect(result.success).toBe(false);
    });
  });

  describe("checkpoint", () => {
    it("accepts an abbreviated or full lowercase hex sha", () => {
      expect(CapabilitySchema.safeParse(baseCapability({ checkedAt: { sha: "3a768cb", date: "2026-09-20" } })).success).toBe(true);
      expect(CapabilitySchema.safeParse(baseCapability({ checkedAt: { sha: "a".repeat(40), date: "2026-09-20" } })).success).toBe(true);
    });

    it("rejects a too-short, uppercase or non-hex sha and a malformed date", () => {
      const bad = [
        { sha: "3a768c", date: "2026-09-20" },
        { sha: "3A768CB3", date: "2026-09-20" },
        { sha: "zzzzzzz", date: "2026-09-20" },
        { sha: "3a768cb3", date: "20-09-2026" },
        { sha: "3a768cb3", date: "2026-13-01" },
      ];
      for (const checkedAt of bad) {
        expect(CapabilitySchema.safeParse(baseCapability({ checkedAt })).success, JSON.stringify(checkedAt)).toBe(false);
      }
    });

    it("requires the checkpoint itself", () => {
      const { checkedAt: _omitted, ...withoutCheckpoint } = baseCapability();
      expect(CapabilitySchema.safeParse(withoutCheckpoint).success).toBe(false);
    });
  });
});

describe("CapabilityCatalogSchema", () => {
  it("parses the schema-shaped empty document", () => {
    const result = CapabilityCatalogSchema.safeParse({ version: 1, capabilities: [] });
    expect(result.success).toBe(true);
  });

  it("defaults a missing capabilities array to empty", () => {
    const result = CapabilityCatalogSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.capabilities).toEqual([]);
  });

  it("refuses a future version rather than passing it through", () => {
    expect(CapabilityCatalogSchema.safeParse({ version: 2, capabilities: [] }).success).toBe(false);
    expect(CapabilityCatalogSchema.safeParse({ capabilities: [] }).success).toBe(false);
  });

  it("round trips a populated document and keeps unknown document-level fields", () => {
    const doc = { version: 1, capabilities: [baseCapability()], generatedBy: "cpm-a7" };
    const parsed = CapabilityCatalogSchema.parse(doc);
    const reparsed = CapabilityCatalogSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
    // Against the INPUT as well: two parses agreeing only proves the schema is
    // deterministic, which a transform that dropped the capabilities would be.
    expect(parsed).toMatchObject(doc);
    expect((reparsed as Record<string, unknown>).generatedBy).toBe("cpm-a7");
  });

  it("rejects the document when any one entry is invalid", () => {
    const doc = { version: 1, capabilities: [baseCapability(), baseCapability({ id: "nope" })] };
    expect(CapabilityCatalogSchema.safeParse(doc).success).toBe(false);
  });
});

describe("EntryPointSchema: the backslash rule", () => {
  it("rejects a Windows-style path, and says why rather than just failing", () => {
    const res = EntryPointSchema.safeParse("src\\core\\thing.ts");
    expect(res.success).toBe(false);
    // The earlier rules accept this input; checking the message also pins the
    // actionable forward-slash diagnostic.
    expect(res.success ? "" : res.error.issues[0]!.message).toMatch(/forward slashes/);
  });

  it("rejects a backslash anywhere in the path, not only as a separator", () => {
    for (const bad of ["src\\core", "a\\b/c", "src/core\\thing.ts", "trailing\\"]) {
      const res = EntryPointSchema.safeParse(bad);
      expect(res.success, bad).toBe(false);
    }
  });

  it("is the reason this is a rejection and not a rewrite: a backslash is legal in a POSIX filename", () => {
    // `weird\name.ts` may be a real file. Normalising it to `weird/name.ts`
    // would silently turn a correct entry point into a wrong one, and that is
    // not reversible. Refusing it is.
    expect(EntryPointSchema.safeParse("weird\\name.ts").success).toBe(false);
  });

  it("still accepts the ordinary POSIX paths the other rules allow", () => {
    expect(EntryPointSchema.parse("src/core/catalog.ts")).toBe("src/core/catalog.ts");
    expect(EntryPointSchema.parse("src/core/")).toBe("src/core");
  });
});

function entryMessage(v: string): string {
  const res = EntryPointSchema.safeParse(v);
  return res.success ? `(accepted as ${res.data})` : res.error.issues[0]!.message;
}

describe("EntryPointSchema: lossless forms are normalized, ambiguous forms are rejected", () => {
  it("drops `.` segments and empty segments and strips trailing slashes", () => {
    expect(EntryPointSchema.parse("./a//b/")).toBe("a/b");
    expect(EntryPointSchema.parse("a/./b")).toBe("a/b");
    expect(EntryPointSchema.parse("./src//core/./thing.ts")).toBe("src/core/thing.ts");
  });

  it("judges `..` on the normalized form, so a leading `./` does not smuggle one past the rule", () => {
    expect(entryMessage("./../x")).toMatch(/`\.\.` segment/);
    expect(entryMessage("a/./../b")).toMatch(/`\.\.` segment/);
  });

  it("refuses a path that normalizes to the repo root, and says so rather than calling it empty", () => {
    for (const root of [".", "./", "./.", ".//"]) {
      const message = entryMessage(root);
      expect(message, root).toMatch(/repo root, which is not an entry point/);
      expect(message, root).not.toMatch(/cannot be empty/);
    }
  });

  it("keeps a leading slash, because dropping it would turn an absolute path into a relative one", () => {
    expect(entryMessage("//etc/passwd")).toMatch(/repo-relative, not absolute/);
    expect(entryMessage("/./src")).toMatch(/repo-relative, not absolute/);
  });

  it("stores the normalized form inside a parsed entry", () => {
    const parsed = CapabilitySchema.parse(baseCapability({ entryPoints: ["./src/core/", "src//cli"] }));
    expect(parsed.entryPoints).toEqual(["src/core", "src/cli"]);
  });
});

describe("CapabilitySchema: an entry point may appear once", () => {
  function issuesOf(entryPoints: string[]) {
    const res = CapabilitySchema.safeParse(baseCapability({ entryPoints }));
    return res.success ? [] : res.error.issues;
  }

  it("rejects an exact repeat, pointing at the later index and naming the earlier one", () => {
    const issues = issuesOf(["src/core", "src/cli", "src/core"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["entryPoints", 2]);
    expect(issues[0]!.message).toMatch(/Duplicate entry point src\/core \(first at entryPoints\.0\)/);
  });

  it("compares NORMALIZED paths, so two spellings of one path are a repeat", () => {
    const issues = issuesOf(["./src/core", "src/core/"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["entryPoints", 1]);
    expect(issues[0]!.message).toMatch(/Duplicate entry point src\/core/);
  });

  it("leaves overlap legal: a directory beside a file inside it is narrowing, not duplication", () => {
    expect(issuesOf(["src/core", "src/core/thing.ts"])).toEqual([]);
  });
});

describe("CapabilityCatalogSchema: capability ids are unique", () => {
  it("rejects a repeated id, pointing at the later entry and naming the earlier one", () => {
    // The FIRST of the pair is the broken one. Downstream code keys results by
    // id, so a later entry with the same id used to overwrite its findings and
    // the broken entry reported current. The document is now refused instead.
    const doc = {
      version: 1,
      capabilities: [
        baseCapability({ id: "cap-dup", entryPoints: ["src/does/not/exist.ts"] }),
        baseCapability({ id: "cap-other" }),
        baseCapability({ id: "cap-dup" }),
      ],
    };
    const res = CapabilityCatalogSchema.safeParse(doc);
    expect(res.success).toBe(false);
    const issues = res.success ? [] : res.error.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["capabilities", 2, "id"]);
    expect(issues[0]!.message).toMatch(/Duplicate capability id cap-dup \(first at capabilities\.0\)/);
  });

  it("accepts distinct ids", () => {
    const doc = { version: 1, capabilities: [baseCapability({ id: "cap-a" }), baseCapability({ id: "cap-b" })] };
    expect(CapabilityCatalogSchema.safeParse(doc).success).toBe(true);
  });
});
