import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, landingTerminalsKey } from "@/lib/persist";

export const DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.36;
export const MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.22;
export const MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.72;

export type LandingTerminalTitleSource = "default" | "manual";

export interface LandingTerminalTabRef {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly name: string;
  readonly titleSource: LandingTerminalTitleSource;
}

export interface LandingTerminalPendingKill {
  readonly hostId: string;
  readonly sessionId: string;
}

export interface LandingTerminalStoreState {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly pendingKills: ReadonlyArray<LandingTerminalPendingKill>;
  readonly setPanelOpen: (open: boolean) => void;
  readonly setPanelWidthFraction: (fraction: number) => void;
  readonly addTab: (tab: LandingTerminalTabRef) => void;
  readonly activateTab: (instanceId: string) => void;
  readonly renameTab: (instanceId: string, name: string) => void;
  /** Atomically tombstones then removes a user-closed tab. */
  readonly closeTab: (instanceId: string) => LandingTerminalTabRef | null;
  /**
   * Atomically tombstones then removes every tab, returning the removed refs so
   * the caller can dispatch one kill each. Same durability contract as
   * {@link closeTab}: the tombstones are written before any kill leaves the
   * renderer, so a reload mid-kill can never re-adopt a closed shell.
   */
  readonly closeAllTabs: () => ReadonlyArray<LandingTerminalTabRef>;
  /** Removes a self-exited tab without asking the host to kill it again. */
  readonly removeExitedTab: (instanceId: string) => void;
  readonly applyReconciliation: (
    tabs: ReadonlyArray<LandingTerminalTabRef>,
    activeInstanceId: string | null,
    collapseWhenEmpty: boolean,
  ) => void;
  readonly clearPendingKill: (hostId: string, sessionId: string) => void;
  readonly rekeyTab: (instanceId: string, sessionId: string) => void;
  readonly resetForTests: () => void;
}

interface PersistedLandingTerminalState {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly pendingKills: ReadonlyArray<LandingTerminalPendingKill>;
}

function initialLandingTerminalState(): PersistedLandingTerminalState {
  return {
    tabs: [],
    activeInstanceId: null,
    panelOpen: false,
    panelWidthFraction: DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
    pendingKills: [],
  };
}

export function clampLandingTerminalPanelWidthFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION;
  }
  return Math.min(
    MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
    Math.max(MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION, value),
  );
}

export function parseLandingTerminalTabRef(
  value: unknown,
): LandingTerminalTabRef | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.hostId) ||
    !isNonEmptyString(value.cwd) ||
    !isNonEmptyString(value.name)
  ) {
    return null;
  }
  const titleSource = parseTitleSource(value.titleSource);
  return {
    instanceId: value.instanceId,
    sessionId: value.sessionId,
    hostId: value.hostId,
    cwd: value.cwd,
    name: value.name,
    titleSource,
  };
}

export function parsePersistedLandingTerminalState(
  value: unknown,
): PersistedLandingTerminalState {
  const initial = initialLandingTerminalState();
  if (!isRecord(value)) return initial;
  const tabs = parseTabs(value.tabs);
  return {
    tabs,
    activeInstanceId: parseActiveInstanceId(value.activeInstanceId, tabs),
    panelOpen: value.panelOpen === true,
    panelWidthFraction:
      typeof value.panelWidthFraction === "number"
        ? clampLandingTerminalPanelWidthFraction(value.panelWidthFraction)
        : initial.panelWidthFraction,
    pendingKills: parsePendingKills(value.pendingKills),
  };
}

export const useLandingTerminalStore = create<LandingTerminalStoreState>()(
  persist(
    (set, get) => ({
      ...initialLandingTerminalState(),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setPanelWidthFraction: (panelWidthFraction) =>
        set({
          panelWidthFraction:
            clampLandingTerminalPanelWidthFraction(panelWidthFraction),
        }),
      addTab: (tab) =>
        set((state) => {
          const existing = state.tabs.find(
            (entry) =>
              entry.instanceId === tab.instanceId ||
              (entry.hostId === tab.hostId &&
                entry.sessionId === tab.sessionId),
          );
          if (existing !== undefined) {
            return {
              activeInstanceId: existing.instanceId,
            };
          }
          return {
            tabs: [...state.tabs, tab],
            activeInstanceId: tab.instanceId,
          };
        }),
      activateTab: (instanceId) =>
        set((state) =>
          state.tabs.some((tab) => tab.instanceId === instanceId)
            ? { activeInstanceId: instanceId }
            : state,
        ),
      renameTab: (instanceId, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.instanceId === instanceId
              ? { ...tab, name: trimmed, titleSource: "manual" }
              : tab,
          ),
        }));
      },
      closeTab: (instanceId) => {
        const closed = get().tabs.find(
          (entry) => entry.instanceId === instanceId,
        );
        if (closed === undefined) return null;
        set((state) => {
          const tabs = state.tabs.filter(
            (entry) => entry.instanceId !== instanceId,
          );
          const pendingKills = hasPendingKill(
            state.pendingKills,
            closed.hostId,
            closed.sessionId,
          )
            ? state.pendingKills
            : [
                ...state.pendingKills,
                { hostId: closed.hostId, sessionId: closed.sessionId },
              ];
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.activeInstanceId,
            ),
            pendingKills,
            panelOpen: tabs.length === 0 ? false : state.panelOpen,
          };
        });
        return closed;
      },
      closeAllTabs: () => {
        const closed = get().tabs;
        if (closed.length === 0) return [];
        set((state) => ({
          tabs: [],
          activeInstanceId: null,
          pendingKills: closed.reduce(
            (pending: ReadonlyArray<LandingTerminalPendingKill>, tab) =>
              hasPendingKill(pending, tab.hostId, tab.sessionId)
                ? pending
                : [
                    ...pending,
                    { hostId: tab.hostId, sessionId: tab.sessionId },
                  ],
            state.pendingKills,
          ),
          panelOpen: false,
        }));
        return closed;
      },
      removeExitedTab: (instanceId) =>
        set((state) => {
          const tabs = state.tabs.filter(
            (tab) => tab.instanceId !== instanceId,
          );
          if (tabs.length === state.tabs.length) return state;
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.activeInstanceId,
            ),
            panelOpen: tabs.length === 0 ? false : state.panelOpen,
          };
        }),
      applyReconciliation: (tabs, activeInstanceId, collapseWhenEmpty) =>
        set((state) => ({
          tabs,
          activeInstanceId: parseActiveInstanceId(activeInstanceId, tabs),
          panelOpen:
            collapseWhenEmpty && tabs.length === 0 ? false : state.panelOpen,
        })),
      clearPendingKill: (hostId, sessionId) =>
        set((state) => ({
          pendingKills: state.pendingKills.filter(
            (pending) =>
              pending.hostId !== hostId || pending.sessionId !== sessionId,
          ),
        })),
      rekeyTab: (instanceId, sessionId) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.instanceId === instanceId ? { ...tab, sessionId } : tab,
          ),
        })),
      resetForTests: () => set(initialLandingTerminalState()),
    }),
    {
      ...basePersistOptions(landingTerminalsKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state): PersistedLandingTerminalState => ({
        tabs: state.tabs,
        activeInstanceId: state.activeInstanceId,
        panelOpen: state.panelOpen,
        panelWidthFraction: state.panelWidthFraction,
        pendingKills: state.pendingKills,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...parsePersistedLandingTerminalState(persistedState),
      }),
    },
  ),
);

function parseTabs(value: unknown): ReadonlyArray<LandingTerminalTabRef> {
  if (!Array.isArray(value)) return [];
  const seenInstanceIds = new Set<string>();
  const seenSessions = new Set<string>();
  return value.flatMap((entry) => {
    const tab = parseLandingTerminalTabRef(entry);
    if (tab === null) return [];
    const sessionKey = terminalSessionKey(tab.hostId, tab.sessionId);
    if (seenInstanceIds.has(tab.instanceId) || seenSessions.has(sessionKey)) {
      return [];
    }
    seenInstanceIds.add(tab.instanceId);
    seenSessions.add(sessionKey);
    return [tab];
  });
}

function parsePendingKills(
  value: unknown,
): ReadonlyArray<LandingTerminalPendingKill> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (!isNonEmptyString(entry.hostId) || !isNonEmptyString(entry.sessionId)) {
      return [];
    }
    const key = terminalSessionKey(entry.hostId, entry.sessionId);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ hostId: entry.hostId, sessionId: entry.sessionId }];
  });
}

function parseActiveInstanceId(
  value: unknown,
  tabs: ReadonlyArray<LandingTerminalTabRef>,
): string | null {
  if (
    typeof value === "string" &&
    tabs.some((tab) => tab.instanceId === value)
  ) {
    return value;
  }
  return tabs[0]?.instanceId ?? null;
}

function parseTitleSource(value: unknown): LandingTerminalTitleSource {
  return value === "manual" ? "manual" : "default";
}

function nextActiveInstanceId(
  tabs: ReadonlyArray<LandingTerminalTabRef>,
  current: string | null,
): string | null {
  if (current !== null && tabs.some((tab) => tab.instanceId === current)) {
    return current;
  }
  return tabs[0]?.instanceId ?? null;
}

function hasPendingKill(
  pendingKills: ReadonlyArray<LandingTerminalPendingKill>,
  hostId: string,
  sessionId: string,
): boolean {
  return pendingKills.some(
    (pending) => pending.hostId === hostId && pending.sessionId === sessionId,
  );
}

export function terminalSessionKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
