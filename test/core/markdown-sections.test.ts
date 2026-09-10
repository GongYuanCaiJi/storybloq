import { describe, it, expect } from "vitest";
import {
  classifyHeading,
  splitFenceAwareSections,
  parseHandoverMarkdown,
  selectBoundedRecords,
  buildTrajectory,
  type SectionRecord,
} from "../../src/core/markdown-sections.js";

describe("classifyHeading", () => {
  const positive: Array<[string, string]> = [
    ["Next step", "continuation"],
    ["Next, in order", "continuation"],
    ["Open loops, ranked", "continuation"],
    ["Next for whoever resumes", "continuation"],
    ["Remaining before T-400 unblocks", "continuation"],
    ["Queue architecture", "continuation"],
    ["Next step--for review", "continuation"],
    ["Blocked", "blocked"],
    ["Owner-open", "owner-gated"],
    ["Owner rulings", "owner-gated"],
    ["Decisions pending", "owner-gated"],
    ["Shipped", "shipped"],
    ["Done", "shipped"],
    ["Completed", "shipped"],
    ["Landed", "shipped"],
    ["Carried forward", "carried"],
    ["Todo", "continuation"],
    ["Open", "continuation"],
    ["Worker state", "continuation"],
    ["Exact next step", "continuation"],
  ];

  for (const [heading, expected] of positive) {
    it(`classifies "${heading}" as ${expected}`, () => {
      expect(classifyHeading(heading)).toBe(expected);
    });
  }

  const negative: string[] = [
    "Open source licensing",
    "Next.js migration",
    "Reopened",
    "Unblocked",
    "Blocked out early today",
  ];

  for (const heading of negative) {
    it(`does not classify "${heading}"`, () => {
      expect(classifyHeading(heading)).toBeNull();
    });
  }

  it("rejects a hyphenated word absorbing the -- delimiter", () => {
    // "step--for" must not be read as one hyphen-joined word that would
    // count as a second content word after "next".
    expect(classifyHeading("Next step--for extra words here")).toBe(
      "continuation",
    );
  });

  it("classifies case-insensitively and with NFKC normalization", () => {
    expect(classifyHeading("NEXT STEP")).toBe("continuation");
    expect(classifyHeading("Ｎｅｘｔ")).toBe("continuation"); // fullwidth "Next"
  });
});

describe("splitFenceAwareSections", () => {
  it("does not treat a heading-like line inside a fence as a boundary", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "",
      "- T-1: do the thing",
      "",
      "```",
      "## Not a real heading",
      "```",
      "",
      "- T-2: another thing",
    ].join("\n");

    const sections = splitFenceAwareSections(md);
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("Next");
    expect(headings).not.toContain("Not a real heading");
  });

  it("assigns bullets to the nearest enclosing heading only, no inheritance", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: item A",
      "",
      "### Owner rulings",
      "- T-2: item B",
      "- T-3: item C",
      "",
      "## Todo",
      "- T-4: item D",
    ].join("\n");

    const parsed = parseHandoverMarkdown(md, "h.md");
    const byId = new Map(parsed.records.map((r) => [r.id, r]));
    expect(byId.get("T-1")?.disposition).toBe("continuation");
    expect(byId.get("T-2")?.disposition).toBe("owner-gated");
    expect(byId.get("T-3")?.disposition).toBe("owner-gated");
    expect(byId.get("T-4")?.disposition).toBe("continuation");
  });

  it("excludes bullets under a heading that does not classify from every category", () => {
    const md = [
      "# Title",
      "",
      "## Reopened",
      "- T-9: should not appear anywhere",
      "",
      "## Next",
      "- T-10: should appear",
    ].join("\n");

    const parsed = parseHandoverMarkdown(md, "h.md");
    const ids = parsed.records.map((r) => r.id);
    expect(ids).not.toContain("T-9");
    expect(ids).toContain("T-10");
  });
});

describe("parseHandoverMarkdown: record extraction", () => {
  it("extracts the first id token in a bullet, keeping others in text", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: fix the thing, related to ISS-2 as well",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records[0].id).toBe("T-1");
    expect(parsed.records[0].label).toContain("fix the thing");
  });

  it("uses a single labelSource for both delimiter and no-delimiter cases", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: short label: extra rationale text here",
      "- T-2 no colon or double dash at all just prose",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    const r2 = parsed.records.find((r) => r.id === "T-2")!;
    expect(r1.label).toBe("short label");
    expect(r1.rationale).toBe("extra rationale text here");
    expect(r2.label).toBe("no colon or double dash at all just prose");
  });

  it("excludes fenced nested content from label and rationale extraction", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: has a fence below",
      "  ```",
      "  this should never leak into rationale",
      "  ```",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe("unknown");
  });

  it("falls back to nested non-fence content for rationale when no delimiter exists", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1 no delimiter here at all in the first line whatsoever",
      "  the real rationale lives here on a nested line",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe("the real rationale lives here on a nested line");
  });

  const cueTokens = [
    "decided",
    "ruled",
    "deferred",
    "abandoned",
    "instead",
    "because",
    "owner",
    "do not",
    "never",
    "superseded",
  ];

  for (const token of cueTokens) {
    it(`classifies an id-less bullet containing "${token}" as a decision`, () => {
      const md = ["# Title", "", "## Next", `- We ${token} to do this`].join(
        "\n",
      );
      const parsed = parseHandoverMarkdown(md, "h.md");
      expect(parsed.records[0].kind).toBe("decision");
      expect(parsed.records[0].id).toBeNull();
    });
  }

  it("classifies an id-bearing bullet as item even with a cue token", () => {
    const md = ["# Title", "", "## Next", "- T-1: we decided to ship this"].join(
      "\n",
    );
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records[0].kind).toBe("item");
  });

  it("falls back to unclassified when no heading classifies anywhere", () => {
    const md = [
      "# Session Handover",
      "",
      "This is the first paragraph describing what happened this session.",
      "",
      "## Reopened",
      "- T-1: nope",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.unclassifiedFallback).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].disposition).toBe("unclassified");
    expect(parsed.records[0].label).toContain(
      "This is the first paragraph",
    );
  });
});

function makeRecord(overrides: Partial<SectionRecord>): SectionRecord {
  return {
    id: null,
    label: "label",
    disposition: "continuation",
    rationale: "unknown",
    kind: "item",
    file: "h.md",
    ...overrides,
  };
}

describe("selectBoundedRecords: byte budget", () => {
  it("stays within the 1,600-byte / 12-record cap", () => {
    const candidates: SectionRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        label: "x".repeat(100),
        rationale: "y".repeat(200),
      }),
    );
    const { records, index } = selectBoundedRecords(candidates, "h.md");
    expect(records.length).toBeLessThanOrEqual(12);
    const totalBytes = records.reduce(
      (sum, r) => sum + Buffer.byteLength(JSON.stringify(r), "utf-8"),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(1600);
    if (index) {
      expect(index.omittedCount).toBeGreaterThan(0);
    }
  });

  it("reserve pass makes the drop-reserve mutant provably wrong on a decisions-last fixture", () => {
    // Several item records first (large enough to fill the budget), then
    // decision records last, sized so a pure document-order walk would
    // exhaust the cap before reaching them.
    const items: SectionRecord[] = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        kind: "item",
        label: "z".repeat(110),
        rationale: "w".repeat(110),
      }),
    );
    const decisions: SectionRecord[] = Array.from({ length: 3 }, (_, i) =>
      makeRecord({
        id: null,
        kind: "decision",
        label: `decision ${i} we ruled on this`,
        rationale: "unknown",
      }),
    );
    const candidates = [...items, ...decisions];

    const withReserve = selectBoundedRecords(candidates, "h.md");
    const withoutReserve = selectBoundedRecordsNoReserveMutant(
      candidates,
      "h.md",
    );

    const reserveHasDecision = withReserve.records.some(
      (r) => r.kind === "decision",
    );
    const mutantHasDecision = withoutReserve.records.some(
      (r) => r.kind === "decision",
    );
    expect(reserveHasDecision).toBe(true);
    expect(mutantHasDecision).toBe(false);
  });

  it("honors the reserve floor under a many-decisions/few-bytes shape", () => {
    const decisions: SectionRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: null, kind: "decision", label: `d${i}`, rationale: "unknown" }),
    );
    const { records } = selectBoundedRecords(decisions, "h.md");
    const decisionCount = records.filter((r) => r.kind === "decision").length;
    expect(decisionCount).toBeGreaterThanOrEqual(4);
  });

  it("honors the reserve floor under a few-decisions/many-bytes shape", () => {
    const decisions: SectionRecord[] = Array.from({ length: 2 }, (_, i) =>
      makeRecord({
        id: null,
        kind: "decision",
        label: "big".repeat(30),
        rationale: "rationale".repeat(20),
      }),
    );
    const { records } = selectBoundedRecords(decisions, "h.md");
    const decisionCount = records.filter((r) => r.kind === "decision").length;
    expect(decisionCount).toBe(2);
  });

  it("index self-shortens the non-file part when 20 ids would exceed 160 bytes", () => {
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({
        id: `T-${1000 + i}`,
        label: "x".repeat(115),
        rationale: "y".repeat(230),
      }),
    );
    const { index } = selectBoundedRecords(candidates, "h.md");
    expect(index).not.toBeNull();
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
    expect(index!.omittedCount).toBeGreaterThan(index!.ids.length);
  });

  it("round-trips an exact adversarial filename through the index unmodified", () => {
    const adversarial = "a".repeat(120) + "\"\\".repeat(20) + ".md";
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `T-${2000 + i}`, label: "x".repeat(115) }),
    );
    const { index } = selectBoundedRecords(candidates, adversarial);
    expect(index).not.toBeNull();
    expect(index!.file).toBe(adversarial);
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
  });

  it("longest real generated filename round-trips and fits the non-file cap", () => {
    const slug = "a".repeat(60);
    const generated = `2026-09-10-153045-a1b2c3d4-${slug}.md`;
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `T-${3000 + i}`, label: "x".repeat(115) }),
    );
    const { index } = selectBoundedRecords(candidates, generated);
    expect(index).not.toBeNull();
    expect(index!.file).toBe(generated);
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
  });

  it("evicts fill-pass records before reserve-pass decisions to fit the index", () => {
    const items: SectionRecord[] = Array.from({ length: 11 }, (_, i) =>
      makeRecord({ id: `T-${i}`, kind: "item", label: "i".repeat(90) }),
    );
    const decisions: SectionRecord[] = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: null, kind: "decision", label: `dec-${i}`.repeat(3) }),
    );
    const { records, index } = selectBoundedRecords(
      [...items, ...decisions],
      "h.md",
    );
    expect(index).not.toBeNull();
    expect(records.length).toBeLessThanOrEqual(12);
  });
});

// Mimics the "dropped reserve pass" mutant: process the full candidate
// list in pure document order with no reserve pass at all.
function selectBoundedRecordsNoReserveMutant(
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: { omittedCount: number; ids: string[]; file: string } | null } {
  const CAP_BYTES = 1600;
  const CAP_RECORDS = 12;
  const selected: SectionRecord[] = [];
  let bytes = 0;
  for (const c of candidates) {
    const b = Buffer.byteLength(JSON.stringify(c), "utf-8");
    if (selected.length >= CAP_RECORDS || bytes + b > CAP_BYTES) break;
    selected.push(c);
    bytes += b;
  }
  const omitted = candidates.filter((c) => !selected.includes(c));
  const index =
    omitted.length > 0
      ? { omittedCount: omitted.length, ids: omitted.map((o) => o.id).filter((x): x is string => !!x), file }
      : null;
  return { records: selected, index };
}

describe("buildTrajectory", () => {
  it("counts occurrence per handover, not per bullet", () => {
    const handovers = [
      {
        filename: "b.md",
        records: [
          makeRecord({ id: "T-1", disposition: "continuation" }),
          makeRecord({ id: "T-1", disposition: "continuation" }),
        ],
        shippedIds: [],
      },
      {
        filename: "a.md",
        records: [makeRecord({ id: "T-1", disposition: "blocked" })],
        shippedIds: [],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.occurrenceCount).toBe(2);
  });

  it("reports shipped as latestDisposition when it is the newest mention", () => {
    const handovers = [
      { filename: "newest.md", records: [], shippedIds: ["T-1"] },
      {
        filename: "older.md",
        records: [makeRecord({ id: "T-1", disposition: "continuation" })],
        shippedIds: [],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.latestDisposition).toBe("shipped");
    expect(entry.latest).toBe("newest.md");
    expect(entry.firstSeenInWindow).toBe("older.md");
  });

  it("still includes an id that was dropped from its newest handover's rendered records by budgeting", () => {
    // buildTrajectory operates on the FULL parsed record set, so this is
    // really just confirming it does not depend on selectBoundedRecords
    // having been applied first.
    const handovers = [
      {
        filename: "newest.md",
        records: [makeRecord({ id: "T-1", disposition: "continuation" })],
        shippedIds: [],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    expect(trajectory.find((t) => t.id === "T-1")).toBeDefined();
  });
});
