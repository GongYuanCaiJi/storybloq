/**
 * Sample projects for the sidebar Mod, one directory per ledger state, so the
 * board can be looked at in every state it has to handle: open Claude Code in
 * a sample and the pane draws that state.
 *
 *   npx tsx scripts/sidebar-states.ts [target-dir]
 *
 * Default target: ~/Developer/sidebar-states. Every sample is rewritten from
 * scratch on each run (the target's other contents are left alone). The
 * ledger files are written directly in the shape the CLI writes, so a sample
 * needs no CLI to exist and is the same on every machine; `storybloq
 * validate` passes in every sample, so the CLI and the Mod read the same
 * ledger.
 *
 * `npx tsx scripts/sidebar-render.ts <sample>` draws a sample's pane as text
 * without a client, for a quick look at all of them at once.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Ticket {
  id: string;
  title: string;
  status: "open" | "inprogress" | "complete";
  phase: string;
  order: number;
  blockedBy?: string[];
  parentTicket?: string;
}

interface Issue {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "resolved";
}

interface Sample {
  readonly name: string;
  readonly about: string;
  readonly phases: readonly { id: string; name: string }[];
  readonly tickets: readonly Ticket[];
  readonly issues: readonly Issue[];
  /** No `.story/` at all: a plain project. */
  readonly noLedger?: boolean;
}

const DAY = "2026-09-19";

function t(id: number, title: string, status: Ticket["status"], phase: string, extra: Partial<Ticket> = {}): Ticket {
  return { id: `T-${String(id).padStart(3, "0")}`, title, status, phase, order: id * 10, ...extra };
}

function i(id: number, title: string, severity: Issue["severity"], status: Issue["status"] = "open"): Issue {
  return { id: `ISS-${String(id).padStart(3, "0")}`, title, severity, status };
}

function many(count: number, status: Ticket["status"], phase: string, from: number, prefix: string): Ticket[] {
  return Array.from({ length: count }, (_, n) => t(from + n, `${prefix} ${n + 1}`, status, phase));
}

const SAMPLES: readonly Sample[] = [
  {
    name: "empty",
    about: "A ledger with nothing in it: init ran, nothing was filed. Every column says none, the footer says issues: none, the band says no phase.",
    phases: [],
    tickets: [],
    issues: [],
  },
  {
    name: "planned",
    about: "Phases and tickets filed, nothing started, no issues. Open carries everything; the narrow strip has nothing in progress and falls back to Open.",
    phases: [{ id: "setup", name: "Setup" }, { id: "core", name: "Core" }],
    tickets: [
      t(1, "Project skeleton and CI", "open", "setup"),
      t(2, "Lint and format on commit", "open", "setup"),
      t(3, "Data model", "open", "core"),
      t(4, "Persistence layer", "open", "core"),
      t(5, "Sync engine", "open", "core"),
      t(6, "Conflict resolution", "open", "core"),
      t(7, "Import from CSV", "open", "core"),
      t(8, "Export to CSV", "open", "core"),
    ],
    issues: [],
  },
  {
    name: "active",
    about: "Mid-project: blocked, open, in progress and done all populated; issues of every severity, two of them resolved. The ordinary board.",
    phases: [{ id: "setup", name: "Setup" }, { id: "core", name: "Core" }, { id: "polish", name: "Polish" }],
    tickets: [
      t(1, "Project skeleton and CI", "complete", "setup"),
      t(2, "Lint and format on commit", "complete", "setup"),
      t(3, "Data model", "complete", "core"),
      t(4, "Persistence layer", "complete", "core"),
      t(5, "Sync engine", "inprogress", "core"),
      t(6, "Conflict resolution", "open", "core", { blockedBy: ["T-005"] }),
      t(7, "Import from CSV", "inprogress", "core"),
      t(8, "Export to CSV", "open", "core", { blockedBy: ["T-007"] }),
      t(9, "Settings screen", "inprogress", "polish"),
      t(10, "Onboarding flow", "open", "polish"),
      t(11, "Keyboard shortcuts", "open", "polish"),
      t(12, "Dark mode", "open", "polish"),
      t(13, "Accessibility labels", "open", "polish"),
      t(14, "Release notes page", "open", "polish"),
    ],
    issues: [
      i(1, "Crash on empty import file", "critical"),
      i(2, "Sync loses the last edit under contention", "high"),
      i(3, "Export writes BOM on macOS", "high"),
      i(4, "Settings screen flickers on open", "medium"),
      i(5, "Onboarding copy is out of date", "medium"),
      i(6, "Shortcut list is not sorted", "medium"),
      i(7, "Dark mode contrast on tooltips", "low"),
      i(8, "Typo in the about box", "low"),
      i(9, "Old: CI cache miss on every run", "medium", "resolved"),
      i(10, "Old: lint rule too strict", "low", "resolved"),
    ],
  },
  {
    name: "complete",
    about: "Everything done and every issue resolved. Done carries every ticket, the other columns say none, the footer says issues: none, the band says all phases complete.",
    phases: [{ id: "setup", name: "Setup" }, { id: "core", name: "Core" }],
    tickets: [
      t(1, "Project skeleton and CI", "complete", "setup"),
      t(2, "Lint and format on commit", "complete", "setup"),
      t(3, "Data model", "complete", "core"),
      t(4, "Persistence layer", "complete", "core"),
      t(5, "Sync engine", "complete", "core"),
      t(6, "Conflict resolution", "complete", "core"),
      t(7, "Import from CSV", "complete", "core"),
      t(8, "Export to CSV", "complete", "core"),
    ],
    issues: [
      i(1, "Crash on empty import file", "critical", "resolved"),
      i(2, "Sync loses the last edit under contention", "high", "resolved"),
      i(3, "Typo in the about box", "low", "resolved"),
    ],
  },
  {
    name: "issues-only",
    about: "No tickets at all, only open issues: the ticket columns say none while Open and the footer carry the issues.",
    phases: [],
    tickets: [],
    issues: [
      i(1, "Login form accepts an empty password", "critical"),
      i(2, "Session cookie is not HttpOnly", "high"),
      i(3, "Search is case sensitive", "medium"),
      i(4, "Avatar upload has no size limit", "medium"),
      i(5, "Footer year is hardcoded", "low"),
      i(6, "Favicon missing on the 404 page", "low"),
    ],
  },
  {
    name: "blocked",
    about: "Most of the open work is blocked, one ticket by a blocker that does not exist (T-099): the board counts it as blocked and storybloq validate reports the dangling reference, which is the one sample the validator does not pass. Blocked is the full column and the narrow strip has one in-progress card.",
    phases: [{ id: "core", name: "Core" }],
    tickets: [
      t(1, "Vendor contract signed", "open", "core"),
      t(2, "Payment provider chosen", "inprogress", "core"),
      t(3, "Checkout flow", "open", "core", { blockedBy: ["T-002"] }),
      t(4, "Refund flow", "open", "core", { blockedBy: ["T-003"] }),
      t(5, "Invoice PDF", "open", "core", { blockedBy: ["T-001", "T-002"] }),
      t(6, "Tax rules by region", "open", "core", { blockedBy: ["T-099"] }),
      t(7, "Receipts by email", "open", "core", { blockedBy: ["T-003"] }),
    ],
    issues: [i(1, "Waiting on legal for the contract wording", "high")],
  },
  {
    name: "umbrella",
    about: "Parent tickets with children: the umbrellas are not on the board, only their leaves are, so the counts match storybloq status.",
    phases: [{ id: "v1", name: "Version 1" }],
    tickets: [
      t(1, "Authentication (umbrella)", "open", "v1"),
      t(2, "Password login", "complete", "v1", { parentTicket: "T-001" }),
      t(3, "Magic link login", "inprogress", "v1", { parentTicket: "T-001" }),
      t(4, "Passkeys", "open", "v1", { parentTicket: "T-001" }),
      t(5, "Billing (umbrella)", "open", "v1"),
      t(6, "Plans and prices", "open", "v1", { parentTicket: "T-005" }),
      t(7, "Stripe webhooks", "open", "v1", { parentTicket: "T-005", blockedBy: ["T-006"] }),
    ],
    issues: [i(1, "Magic link expires too fast", "medium")],
  },
  {
    name: "overflow",
    about: "Far more than a column can show: every column is capped with a tail, the footer has three-digit counts, and the narrow strip says how many more.",
    phases: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
    tickets: [
      ...many(30, "complete", "a", 1, "Alpha task done"),
      ...many(25, "open", "b", 100, "Beta task open"),
      ...many(9, "inprogress", "b", 200, "Beta task in hand"),
      ...many(12, "open", "b", 300, "Beta task waiting").map((x) => ({ ...x, blockedBy: ["T-200"] })),
    ],
    issues: [
      ...Array.from({ length: 4 }, (_, n) => i(1 + n, `Critical issue ${n + 1}`, "critical")),
      ...Array.from({ length: 18 }, (_, n) => i(10 + n, `High issue ${n + 1}`, "high")),
      ...Array.from({ length: 120 }, (_, n) => i(100 + n, `Medium issue ${n + 1}`, "medium")),
      ...Array.from({ length: 33 }, (_, n) => i(300 + n, `Low issue ${n + 1}`, "low")),
    ],
  },
  {
    name: "wide-text",
    about: "Titles that stress the cell arithmetic: CJK, emoji, combining marks, and titles far longer than any column, so truncation has to cut on cell width and keep the id whole.",
    phases: [{ id: "i18n", name: "Internationalisation" }],
    tickets: [
      t(1, "日本語のタイトルはセル幅が二倍になるので切り詰めが難しい", "inprogress", "i18n"),
      t(2, "Emoji in the title 🚀🔥✨ and after it more words to cut", "inprogress", "i18n"),
      t(3, "Zoë's naïve résumé façade with combining marks é à", "open", "i18n"),
      t(4, "A title so long it has no business on any board at all, and yet here it is, running on past every column width the pane could ever be given", "open", "i18n"),
      t(5, "한국어 제목", "complete", "i18n"),
      t(6, "Ελληνικά και кириллица mixed", "open", "i18n", { blockedBy: ["T-001"] }),
    ],
    issues: [
      i(1, "🐛 emoji-led issue title", "high"),
      i(2, "中文问题标题，很长很长很长很长很长很长很长很长很长很长很长", "medium"),
    ],
  },
  {
    name: "no-ledger",
    about: "A plain project without .story: the Mod draws nothing and opens no pane.",
    phases: [],
    tickets: [],
    issues: [],
    noLedger: true,
  },
];

function writeSample(root: string, sample: Sample): void {
  const dir = join(root, sample.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${sample.name}\n\n${sample.about}\n\nOpen Claude Code here to see the Storybloq sidebar in this state.\n`);
  if (sample.noLedger) return;
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(story, sub), { recursive: true });
  writeFileSync(
    join(story, "config.json"),
    JSON.stringify(
      {
        version: 2,
        project: `sidebar-${sample.name}`,
        type: "npm",
        language: "typescript",
        features: { tickets: true, issues: true, roadmap: true, handovers: true, reviews: true, bus: true },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(story, "roadmap.json"),
    JSON.stringify(
      {
        title: `sidebar-${sample.name}`,
        date: DAY,
        phases: sample.phases.map((p, n) => ({ id: p.id, name: p.name, label: `PHASE ${n + 1}`, summary: p.name, description: p.name })),
        blockers: [],
      },
      null,
      2,
    ) + "\n",
  );
  for (const ticket of sample.tickets) {
    const record: Record<string, unknown> = {
      id: ticket.id,
      title: ticket.title,
      type: "task",
      status: ticket.status,
      phase: ticket.phase,
      order: ticket.order,
      blockedBy: ticket.blockedBy ?? [],
      createdDate: DAY,
      completedDate: ticket.status === "complete" ? DAY : null,
      description: sample.about,
    };
    if (ticket.parentTicket !== undefined) record["parentTicket"] = ticket.parentTicket;
    writeFileSync(join(story, "tickets", `${ticket.id}.json`), JSON.stringify(record, null, 2) + "\n");
  }
  for (const issue of sample.issues) {
    const record: Record<string, unknown> = {
      id: issue.id,
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
      discoveredDate: DAY,
      components: [],
      location: [],
      relatedTickets: [],
      impact: sample.about,
      resolution: issue.status === "resolved" ? "Fixed for the sample." : null,
      resolvedDate: issue.status === "resolved" ? DAY : null,
    };
    writeFileSync(join(story, "issues", `${issue.id}.json`), JSON.stringify(record, null, 2) + "\n");
  }
}

const target = process.argv[2] ?? join(homedir(), "Developer", "sidebar-states");
mkdirSync(target, { recursive: true });
for (const sample of SAMPLES) writeSample(target, sample);
writeFileSync(
  join(target, "README.md"),
  `# Sidebar states\n\nOne sample project per ledger state for the Storybloq sidebar. Open Claude Code in a sample to see the board in that state; \`npx tsx scripts/sidebar-render.ts <sample>\` in the storybloq package draws it as text.\n\n${SAMPLES.map((s) => `- \`${s.name}\`: ${s.about}`).join("\n")}\n`,
);
console.log(`${SAMPLES.length} samples written under ${target}${existsSync(target) ? "" : " (missing?)"}`);
for (const s of SAMPLES) console.log(`  ${s.name}`);
