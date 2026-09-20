import type { SidebarProjection } from "./sidebar-projection.js";

const CARD_MS = 1400;
const READY_MS = 1800;
const COUNT_MS = 1000;
const PHASE_MS = 2100;
const CONTEXT_MS = 650;
const MAX_CARD_EFFECTS = 128;

type CardState = { column: string; blocked: boolean };
type CardEffect = { age: number; ready: boolean };
type PhaseEffect = { age: number; completed: Set<string>; from: string | null; to: string | null };
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const ease = (n: number): number => 1 - (1 - clamp(n)) ** 3;

/** Presentation only. Actual statuses, counts, and percentages always come from the ledger/client. */
export class DashboardMotion {
  private cards: Map<string, CardState> | null = null;
  private phases: SidebarProjection["phases"] = [];
  private root: string | null = null;
  private cardEffects = new Map<string, CardEffect>();
  private counts = new Map<string, number>();
  private phase: PhaseEffect | null = null;
  private working = false;
  private activityMs = 0;
  private turnId: string | null = null;
  private context: number | null = null;
  private lastContext: number | null = null;
  private contextTween: { from: number; to: number; age: number } | null = null;
  private frameMs = 0;

  constructor(readonly enabled = true, private readonly highlights = true) {}

  observe(projection: SidebarProjection, root: string | null): void {
    const current = new Map<string, CardState>();
    for (const [column, cards] of Object.entries(projection.board)) {
      for (const card of cards) current.set(card.key, { column, blocked: card.blocked });
    }
    if (root !== this.root) {
      this.cards = null;
      this.cardEffects.clear();
      this.counts.clear();
      this.phase = null;
      this.phases = [];
    }
    if (this.enabled && this.cards !== null) {
      if (this.highlights) {
        for (const [key, card] of current) {
          const before = this.cards.get(key);
          if (!before) continue;
          if (before.column !== card.column || before.blocked !== card.blocked) {
            this.cardEffects.delete(key);
            this.cardEffects.set(key, {
              age: 0,
              ready: before.blocked && !card.blocked && card.column !== "done",
            });
            if (before.column !== card.column) this.counts.set(card.column, 0);
          }
        }
      }
      const beforePhases = new Map(this.phases.map(phase => [phase.id, phase.status]));
      const completed = projection.phases.filter(phase => phase.leafCount > 0 && phase.status === "complete"
        && beforePhases.has(phase.id) && beforePhases.get(phase.id) !== "complete");
      if (completed.length) {
        const previousCurrent = this.phases.find(phase => phase.status === "inprogress");
        const from = completed.find(phase => phase.id === previousCurrent?.id)?.id ?? completed[0]!.id;
        const fromIndex = projection.phases.findIndex(phase => phase.id === from);
        this.phase = {
          age: 0, completed: new Set(completed.map(phase => phase.id)), from,
          to: projection.phases[fromIndex + 1]?.id ?? null,
        };
      }
    }
    for (const key of this.cardEffects.keys()) if (!current.has(key)) this.cardEffects.delete(key);
    while (this.cardEffects.size > MAX_CARD_EFFECTS) this.cardEffects.delete(this.cardEffects.keys().next().value!);
    // Reopening/removing a phase cancels stale celebration immediately.
    if (this.phase && [...this.phase.completed].some(id => !projection.phases.some(p => p.id === id && p.status === "complete"))) this.phase = null;
    this.cards = current;
    this.phases = projection.phases;
    this.root = root;
  }

  setWorking(working: boolean, turnId?: string): void {
    if (working !== this.working) this.activityMs = 0;
    this.working = working;
    if (!working) this.turnId = null;
    else if (turnId) this.turnId = turnId;
  }

  finishTurn(turnId?: string, agentId?: string): void {
    if (agentId || (turnId && this.turnId && turnId !== this.turnId)) return;
    this.setWorking(false);
  }

  activity(): { glyph: string; bright: boolean; working: boolean } {
    if (!this.working) return { glyph: "·", bright: false, working: false };
    if (!this.enabled) return { glyph: "●", bright: true, working: true };
    const beat = Math.floor(this.activityMs / 240) % 6;
    return { glyph: ["·", "•", "●", "●", "•", "·"][beat]!, bright: beat === 2 || beat === 3, working: true };
  }

  setContext(value: number | null, immediate = false): void {
    const next = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
    if (next === this.context && !immediate) return;
    const from = this.meterValue() ?? this.lastContext;
    this.context = next;
    this.contextTween = this.enabled && !immediate && from !== null && next !== null && from !== next
      ? { from, to: next, age: 0 } : null;
    if (next !== null) this.lastContext = next;
  }

  meterValue(): number | null {
    if (this.context === null) return null;
    const tween = this.contextTween;
    return tween ? tween.from + (tween.to - tween.from) * ease(tween.age / CONTEXT_MS) : this.context;
  }

  card(key: string): { progress: number | null; ready: boolean; fading: boolean } {
    const effect = this.cardEffects.get(key);
    return {
      progress: effect && effect.age < CARD_MS ? ease(effect.age / CARD_MS) : null,
      ready: !!effect?.ready,
      fading: !!effect && effect.age > READY_MS - 300,
    };
  }

  count(column: string): boolean { return this.counts.has(column); }

  phaseMarker(id: string, settled: string): string {
    const effect = this.phase;
    if (!effect) return settled;
    if (effect.completed.has(id) && effect.age < 360) return ["◔", "◑", "◕", "●"][Math.floor(effect.age / 90)]!;
    if (id === effect.to && settled === "◎" && effect.age < 1000) return effect.age < 800 ? "○" : "◉";
    return settled;
  }

  connection(from: string, to: string): number | null {
    const effect = this.phase;
    return effect?.from === from && effect.to === to && effect.age < 1100 ? clamp((effect.age - 360) / 440) : null;
  }

  /** A single dot crest travels across the existing connector cells, after the handoff. */
  wave(position: number): "" | "·" | "•" {
    if (!this.phase || this.phase.age < 1100) return "";
    const progress = (this.phase.age - 1100) / (PHASE_MS - 1100);
    const distance = Math.abs(position - (progress * 1.3 - .15));
    return distance < .025 ? "•" : distance < .065 ? "·" : "";
  }

  /** One shared clock; at most 20 redraws/sec while effects run, 5/sec for activity alone. */
  advance(ms: number): boolean {
    const hadEffects = this.cardEffects.size > 0 || this.counts.size > 0 || this.phase !== null || this.contextTween !== null;
    const beforeActivity = this.activity();
    if (this.working && this.enabled) this.activityMs = (this.activityMs + ms) % 1440;
    for (const [key, effect] of this.cardEffects) {
      effect.age += ms;
      if (effect.age >= (effect.ready ? READY_MS : CARD_MS)) this.cardEffects.delete(key);
    }
    for (const [key, age] of this.counts) {
      if (age + ms >= COUNT_MS) this.counts.delete(key);
      else this.counts.set(key, age + ms);
    }
    if (this.phase) { this.phase.age += ms; if (this.phase.age >= PHASE_MS) this.phase = null; }
    if (this.contextTween) { this.contextTween.age += ms; if (this.contextTween.age >= CONTEXT_MS) this.contextTween = null; }
    const activity = this.activity();
    this.frameMs = Math.min(50, this.frameMs + ms);
    const hasEffects = this.cardEffects.size > 0 || this.counts.size > 0 || this.phase !== null || this.contextTween !== null;
    if (hadEffects && (this.frameMs >= 50 || !hasEffects)) { this.frameMs = 0; return true; }
    return beforeActivity.glyph !== activity.glyph || beforeActivity.bright !== activity.bright;
  }
}
