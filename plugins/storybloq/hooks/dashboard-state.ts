import { DashboardMotion } from "./dashboard-motion.js";
import type { SidebarProjection, SidebarRecord } from "./sidebar-projection.js";
export interface CachedRecord {
  readonly mtimeMs: number;
  readonly record: SidebarRecord;
}
export interface ScanItem {
  readonly path: string;
  readonly kind: "ticket" | "issue";
}
/** Owned by one registration; host callbacks retain their own instance. */
export interface DashboardState {
  cache: Record<string, CachedRecord>;
  cacheLoaded: boolean;
  projection: SidebarProjection | null;
  project: string;
  phases: {
    readonly id: string;
    readonly name: string;
    readonly label?: string;
  }[];
  handoverFilenames: string[];
  queue: ScanItem[];
  idleTicks: number;
  polledMtimes: Record<string, number>;
  scanInitializing: boolean;
  scanActive: boolean;
  pendingRefresh: boolean;
  ticking: boolean;
  timerStarted: boolean;
  logoElapsed: number;
  logoStarted: boolean;
  logoFinished: boolean;
  logoTicks: number;
  motion: DashboardMotion;
  bandDrawn: boolean;
  sidebarEnabled: boolean;
  paneOpen: boolean;
  paneDrawn: boolean;
  reopenAsked: boolean;
  themeLight: boolean;
  paneInline: boolean;
  sessionActive: boolean;
  /** T-531: status.json's `state`, `ticket`, `claudeStatus` and `observedAt`; null when absent or malformed. */
  sessionState: string | null;
  sessionTicket: string | null;
  sessionClaudeStatus: string | null;
  sessionObservedAt: string | null;
  contextPercent: number | null;
  warm: boolean;
  uiAvailable: boolean;
  noLedger: boolean;
  saidNoUi: boolean;
  saidNoLedger: boolean;
  saidScanFailed: boolean;
  saidRootUnresolved: boolean;
  initialCwd: string | null;
  ledgerRoot: string | null;
}
export function createDashboardState(): DashboardState {
  return {
    cache: {},
    cacheLoaded: false,
    projection: null,
    project: "",
    phases: [],
    handoverFilenames: [],
    queue: [],
    idleTicks: 0,
    polledMtimes: {},
    scanInitializing: false,
    scanActive: false,
    pendingRefresh: false,
    ticking: false,
    timerStarted: false,
    logoElapsed: 0,
    logoStarted: false,
    logoFinished: false,
    logoTicks: 0,
    motion: new DashboardMotion(),
    bandDrawn: false,
    sidebarEnabled: false,
    paneOpen: false,
    paneDrawn: false,
    reopenAsked: false,
    themeLight: false,
    paneInline: false,
    sessionActive: false,
    sessionState: null,
    sessionTicket: null,
    sessionClaudeStatus: null,
    sessionObservedAt: null,
    contextPercent: null,
    warm: false,
    uiAvailable: true,
    noLedger: false,
    saidNoUi: false,
    saidNoLedger: false,
    saidScanFailed: false,
    saidRootUnresolved: false,
    initialCwd: null,
    ledgerRoot: null,
  };
}
