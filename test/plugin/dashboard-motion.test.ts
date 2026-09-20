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
    expect(motion.phaseMarker("p1", "◎")).toBe("◎");
    motion.observe(project("complete", "complete"), "/repo");
    expect(motion.card("ticket:T-002").ready).toBe(false);
  });

  it("fills the completed marker, advances its line, settles the next marker, then sends one dot wave", () => {
    const motion = new DashboardMotion();
    motion.observe(project(), "/repo");
    motion.observe(project("complete", "inprogress"), "/repo");
    expect(motion.phaseMarker("p1", "✓")).toBe("◔");
    expect(motion.connection("p1", "p2")).toBe(0);
    motion.advance(270);
    expect(motion.phaseMarker("p1", "✓")).toBe("●");
    motion.advance(300);
    expect(motion.phaseMarker("p1", "✓")).toBe("✓");
    expect(motion.connection("p1", "p2")).toBeGreaterThan(0);
    expect(motion.connection("p1", "p2")).toBeLessThan(1);
    expect(motion.phaseMarker("p2", "◎")).toBe("○");
    motion.advance(300);
    expect(motion.connection("p1", "p2")).toBe(1);
    expect(motion.phaseMarker("p2", "◎")).toBe("◉");
    motion.advance(730);
    expect(motion.phaseMarker("p2", "◎")).toBe("◎");
    expect(motion.wave(.5)).toBe("•");
    motion.advance(600);
    expect(motion.wave(.5)).toBe("");
    expect(motion.advance(25)).toBe(false);
    motion.observe(project("complete", "inprogress"), "/repo");
    expect(motion.advance(25)).toBe(false);
  });

  it("does not celebrate a newly discovered or reordered completed phase, or another project's baseline", () => {
    const motion = new DashboardMotion();
    motion.observe(project("complete"), "/repo");
    const next = project("complete");
    motion.observe({ ...next, phases: [...next.phases].reverse() }, "/repo");
    expect(motion.advance(25)).toBe(false);
    motion.observe(project(), "/other");
    expect(motion.card("ticket:T-001").progress).toBeNull();
    motion.observe({ ...project(), phases: [{ id: "new", name: "New", leafCount: 1, status: "complete" }] }, "/other");
    expect(motion.phaseMarker("new", "✓")).toBe("✓");
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
    expect(motion.activity()).toMatchObject({ working: true, glyph: "●" });
    motion.finishTurn("worker", "agent-1");
    motion.finishTurn("older");
    expect(motion.activity().working).toBe(true);
    motion.finishTurn("main");
    expect(motion.activity()).toMatchObject({ working: false, glyph: "·" });
    expect(motion.advance(1000)).toBe(false);
  });

  it("uses static state and no animation redraws when motion is disabled", () => {
    const motion = new DashboardMotion(false);
    motion.observe(project(), "/repo");
    motion.observe(project("complete", "inprogress"), "/repo");
    motion.setContext(20); motion.setContext(90);
    motion.setWorking(true, "main");
    expect(motion.meterValue()).toBe(90);
    expect(motion.activity().glyph).toBe("●");
    expect(motion.phaseMarker("p1", "✓")).toBe("✓");
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
    expect(redraws).toBeLessThanOrEqual(5);
  });
});
