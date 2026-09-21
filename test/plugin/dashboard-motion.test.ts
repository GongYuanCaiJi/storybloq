import { describe, it, expect } from "vitest";
import { DashboardMotion } from "../../plugins/storybloq/hooks/dashboard-motion.js";
import { extractRecord, projectSidebar, type SidebarTicket } from "../../plugins/storybloq/hooks/sidebar-projection.js";

function project(status = "inprogress", dependent = "open") {
  const tickets = [
    { id: "T-001", title: "Foundation", status, phase: "p1", order: 1 },
    { id: "T-002", title: "Next story", status: dependent, phase: "p2", blockedBy: ["T-001"], order: 2 },
  ].map(record => extractRecord("ticket", JSON.stringify(record)) as SidebarTicket);
  return projectSidebar({ project: "fixture", phases: [{ id: "p1", name: "Foundation" }, { id: "p2", name: "Next" }], tickets, issues: [], handoverFilenames: [] });
}

describe("dashboard event animations", () => {
  it("stays quiet on initial reads and unchanged scans, and does not restart a highlight on polling", () => {
    const motion = new DashboardMotion();
    motion.observe(project(), "/repo");
    expect(motion.card("ticket:T-001").progress).toBeNull();
    expect(motion.advance(200)).toBe(false);
    const next = project("complete");
    const saved = JSON.stringify(next);
    motion.observe(next, "/repo");
    expect(motion.count("done")).toBe(true);
    expect(motion.card("ticket:T-002").ready).toBe(true);
    motion.advance(450);
    const progress = motion.card("ticket:T-001").progress;
    motion.observe(project("complete"), "/repo");
    expect(motion.card("ticket:T-001").progress).toBe(progress);
    motion.advance(2000);
    expect(motion.card("ticket:T-001").progress).toBeNull();
    expect(motion.card("ticket:T-002").ready).toBe(false);
    expect(motion.count("done")).toBe(false);
    expect(motion.advance(25)).toBe(false);
    expect(JSON.stringify(next)).toBe(saved);
  });

  it("cancels Ready when blocked again, and never calls a completed story Ready", () => {
    const motion = new DashboardMotion();
    motion.observe(project(), "/repo");
    motion.observe(project("complete"), "/repo");
    expect(motion.card("ticket:T-002").ready).toBe(true);
    motion.observe(project(), "/repo");
    expect(motion.card("ticket:T-002").ready).toBe(false);
    motion.observe(project("complete", "complete"), "/repo");
    expect(motion.card("ticket:T-002").ready).toBe(false);
  });

  it("does not redraw for phase-only changes", () => {
    const motion = new DashboardMotion();
    const baseline = project();
    motion.observe(baseline, "/repo");
    motion.observe({ ...baseline, phases: baseline.phases.map(p => ({ ...p, status: "complete" })) }, "/repo");
    expect(motion.advance(50)).toBe(false);
  });

  it("retargets the context meter smoothly and animates one measured drop after compaction", () => {
    const motion = new DashboardMotion();
    motion.setContext(20, true);
    motion.setContext(80);
    expect(motion.meterValue()).toBe(20);
    motion.advance(100);
    const middle = motion.meterValue()!;
    expect(middle).toBeGreaterThan(20);
    expect(middle).toBeLessThan(80);
    motion.setContext(90);
    expect(motion.meterValue()).toBe(middle);
    motion.advance(650);
    expect(motion.meterValue()).toBe(90);
    motion.setContext(null);
    expect(motion.meterValue()).toBeNull();
    motion.setContext(12);
    expect(motion.meterValue()).toBe(90);
    motion.advance(650);
    expect(motion.meterValue()).toBe(12);
    motion.setContext(12);
    expect(motion.advance(25)).toBe(false);
  });

  it("keeps main activity through subagent and stale completions and settles on interruption", () => {
    const motion = new DashboardMotion();
    expect(motion.activity().working).toBe(false);
    motion.setWorking(true, "main");
    motion.advance(500);
    expect(motion.activity()).toMatchObject({ working: true, sweep: 10 * (50 / 120) });
    motion.finishTurn("worker", "agent-1");
    motion.finishTurn("older");
    expect(motion.activity().working).toBe(true);
    motion.finishTurn("main");
    expect(motion.activity()).toMatchObject({ working: false, sweep: null });
    expect(motion.advance(1000)).toBe(false);
  });

  it("uses static state and no animation redraws when motion is disabled", () => {
    const motion = new DashboardMotion(false);
    motion.observe(project(), "/repo");
    motion.observe(project("complete", "inprogress"), "/repo");
    motion.setContext(20); motion.setContext(90);
    motion.setWorking(true, "main");
    expect(motion.meterValue()).toBe(90);
    expect(motion.activity()).toEqual({ working: true, sweep: null });
    expect(motion.card("ticket:T-002").ready).toBe(false);
    expect(motion.advance(2000)).toBe(false);
  });

  it("caps changed-row effects and redraw rate, then stops invalidating", () => {
    const motion = new DashboardMotion();
    const base = project();
    const cards = Array.from({ length: 200 }, (_, i) => ({ ...base.board.open[0]!, key: `ticket:${i}` }));
    motion.observe({ ...base, board: { open: cards, inProgress: [], done: [] } }, "/repo");
    motion.observe({ ...base, board: { open: [], inProgress: [], done: cards } }, "/repo");
    expect(cards.filter(card => motion.card(card.key).progress !== null)).toHaveLength(128);
    let redraws = 0;
    for (let i = 0; i < 80; i++) if (motion.advance(25)) redraws++;
    expect(redraws).toBeLessThanOrEqual(40);
    expect(motion.advance(25)).toBe(false);
    motion.setWorking(true);
    redraws = 0;
    for (let i = 0; i < 40; i++) if (motion.advance(25)) redraws++;
    expect(redraws).toBeLessThanOrEqual(20);
  });
});
