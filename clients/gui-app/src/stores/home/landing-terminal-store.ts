import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { basePersistOptions, landingTerminalsKey } from "@/lib/persist";
import { selectPlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";

export const DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.36;
export const MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.22;
export const MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION = 0.72;

export type LandingTerminalTitleSource = "default" | "manual";

export const LANDING_TERMINAL_SOURCE_STORE_VERSION = 1;

export interface LandingTerminalTabRef {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly name: string;
  readonly titleSource: LandingTerminalTitleSource;
  /**
   * True only after a capable host acknowledged this logical terminal. The
   * legacy cwd/name/title fields remain downgrade evidence, never semantic
   * authority while this bit is set and a capable host projection is fresh.
   */
  readonly hostAuthorityAcknowledged?: boolean;
  /** A genuinely-new terminal awaiting `terminal.plain.create`. */
  readonly pendingCreate?: boolean;
  /** Schema version attached to legacy import evidence. */
  readonly sourceStoreVersion?: number;
}

export interface LandingTerminalPendingKill {
  readonly hostId: string;
  readonly sessionId: string;
}

export interface LandingTerminalLayout {
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly maximized: boolean;
}

export const DEFAULT_LANDING_TERMINAL_LAYOUT: LandingTerminalLayout = {
  panelOpen: false,
  panelWidthFraction: DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  maximized: false,
};

export interface LandingTerminalStoreState {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly layoutsByLandingPageId: Readonly<
    Partial<Record<string, LandingTerminalLayout>>
  >;
  /**
   * Retains the v1 global layout only for pages that have not yet recorded
   * their own layout. New layout writes always target one landing page.
   */
  readonly fallbackLayout: LandingTerminalLayout | null;
  readonly pendingKills: ReadonlyArray<LandingTerminalPendingKill>;
  readonly setPanelOpen: (landingPageId: string, open: boolean) => void;
  readonly setPanelWidthFraction: (
    landingPageId: string,
    fraction: number,
  ) => void;
  readonly setPanelMaximized: (
    landingPageId: string,
    maximized: boolean,
  ) => void;
  readonly addTab: (tab: LandingTerminalTabRef) => void;
  readonly activateTab: (instanceId: string) => void;
  readonly renameTab: (instanceId: string, name: string) => void;
  /** Refreshes a derived title without overwriting a user rename. */
  readonly syncDefaultTitle: (instanceId: string, name: string) => void;
  /** Atomically tombstones then removes a user-closed tab. */
  readonly closeTab: (
    landingPageId: string,
    instanceId: string,
  ) => LandingTerminalTabRef | null;
  /** Removes a self-exited tab without asking the host to kill it again. */
  readonly removeExitedTab: (landingPageId: string, instanceId: string) => void;
  readonly applyReconciliation: (
    landingPageId: string,
    tabs: ReadonlyArray<LandingTerminalTabRef>,
    activeInstanceId: string | null,
    collapseWhenEmpty: boolean,
  ) => void;
  readonly clearPendingKill: (hostId: string, sessionId: string) => void;
  readonly rekeyTab: (instanceId: string, sessionId: string) => void;
  readonly adoptHostTerminal: (
    instanceId: string,
    terminal: PlainTerminalProjection,
  ) => void;
  readonly removeHostTerminal: (hostId: string, terminalId: string) => void;
  readonly resetForTests: () => void;
}

interface PersistedLandingTerminalState {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly layoutsByLandingPageId: Readonly<
    Partial<Record<string, LandingTerminalLayout>>
  >;
  readonly fallbackLayout: LandingTerminalLayout | null;
  readonly pendingKills: ReadonlyArray<LandingTerminalPendingKill>;
}

function initialLandingTerminalState(): PersistedLandingTerminalState {
  return {
    tabs: [],
    activeInstanceId: null,
    layoutsByLandingPageId: {},
    fallbackLayout: null,
    pendingKills: [],
  };
}

export function landingTerminalLayoutFor(
  state: Pick<
    LandingTerminalStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
  landingPageId: string,
): LandingTerminalLayout {
  return (
    state.layoutsByLandingPageId[landingPageId] ??
    state.fallbackLayout ??
    DEFAULT_LANDING_TERMINAL_LAYOUT
  );
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
    ...(value.hostAuthorityAcknowledged === true
      ? { hostAuthorityAcknowledged: true }
      : {}),
    ...(value.pendingCreate === true ? { pendingCreate: true } : {}),
    ...(isNonNegativeInteger(value.sourceStoreVersion)
      ? { sourceStoreVersion: value.sourceStoreVersion }
      : {}),
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
    layoutsByLandingPageId: parseLandingTerminalLayouts(
      value.layoutsByLandingPageId,
    ),
    fallbackLayout: parseFallbackLayout(value),
    pendingKills: parsePendingKills(value.pendingKills),
  };
}

export const useLandingTerminalStore = create<LandingTerminalStoreState>()(
  persist(
    (set, get) => ({
      ...initialLandingTerminalState(),
      setPanelOpen: (landingPageId, panelOpen) =>
        set((state) =>
          updateLandingTerminalLayout(state, landingPageId, {
            ...landingTerminalLayoutFor(state, landingPageId),
            panelOpen,
          }),
        ),
      setPanelWidthFraction: (landingPageId, panelWidthFraction) =>
        set((state) =>
          updateLandingTerminalLayout(state, landingPageId, {
            ...landingTerminalLayoutFor(state, landingPageId),
            panelWidthFraction:
              clampLandingTerminalPanelWidthFraction(panelWidthFraction),
          }),
        ),
      setPanelMaximized: (landingPageId, maximized) =>
        set((state) =>
          updateLandingTerminalLayout(state, landingPageId, {
            ...landingTerminalLayoutFor(state, landingPageId),
            maximized,
          }),
        ),
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
      syncDefaultTitle: (instanceId, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => {
          const target = state.tabs.find(
            (tab) => tab.instanceId === instanceId,
          );
          if (
            target === undefined ||
            target.titleSource === "manual" ||
            target.name === trimmed
          ) {
            return state;
          }
          return {
            tabs: state.tabs.map((tab) =>
              tab.instanceId === instanceId ? { ...tab, name: trimmed } : tab,
            ),
          };
        });
      },
      closeTab: (_landingPageId, instanceId) => {
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
            ...(tabs.length === 0
              ? collapseLayoutsForEmptyTerminalSet(state)
              : {}),
          };
        });
        return closed;
      },
      removeExitedTab: (_landingPageId, instanceId) =>
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
            ...(tabs.length === 0
              ? collapseLayoutsForEmptyTerminalSet(state)
              : {}),
          };
        }),
      applyReconciliation: (
        _landingPageId,
        tabs,
        activeInstanceId,
        collapseWhenEmpty,
      ) =>
        set((state) => ({
          tabs,
          activeInstanceId: parseActiveInstanceId(activeInstanceId, tabs),
          ...(collapseWhenEmpty && tabs.length === 0
            ? collapseLayoutsForEmptyTerminalSet(state)
            : {}),
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
      // Matched on instance + host only. The canonical terminal a capable host
      // returns for `importLegacy` ("existing"/"imported") may carry a
      // DIFFERENT terminalId than the legacy evidence we sent - the response
      // contract permits it - and rekeying that pointer is exactly what
      // `hostAcknowledgedTab` is for. Also demanding the ids already match
      // dropped the acknowledgement, left the tab unacknowledged beside a
      // freshly adopted canonical duplicate, and re-imported on the next pass.
      adoptHostTerminal: (instanceId, terminal) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.instanceId === instanceId &&
            tab.hostId === terminal.record.hostId
              ? hostAcknowledgedTab(tab, terminal)
              : tab,
          ),
        })),
      removeHostTerminal: (hostId, terminalId) =>
        set((state) => {
          const tabs = state.tabs.filter(
            (tab) => tab.hostId !== hostId || tab.sessionId !== terminalId,
          );
          if (tabs.length === state.tabs.length) return state;
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.activeInstanceId,
            ),
            ...(tabs.length === 0
              ? collapseLayoutsForEmptyTerminalSet(state)
              : {}),
          };
        }),
      resetForTests: () => set(initialLandingTerminalState()),
    }),
    {
      ...basePersistOptions(landingTerminalsKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state): PersistedLandingTerminalState => ({
        tabs: state.tabs,
        activeInstanceId: state.activeInstanceId,
        layoutsByLandingPageId: state.layoutsByLandingPageId,
        fallbackLayout: state.fallbackLayout,
        pendingKills: state.pendingKills,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...parsePersistedLandingTerminalState(persistedState),
      }),
    },
  ),
);

function updateLandingTerminalLayout(
  state: Pick<LandingTerminalStoreState, "layoutsByLandingPageId">,
  landingPageId: string,
  layout: LandingTerminalLayout,
): Pick<LandingTerminalStoreState, "layoutsByLandingPageId"> {
  return {
    layoutsByLandingPageId: {
      ...state.layoutsByLandingPageId,
      [landingPageId]: layout,
    },
  };
}

/**
 * Tabs are shared across landing pages. Once none remain, no page can keep an
 * open terminal surface: that would display a permanently empty panel whose
 * prior opening gesture cannot settle. This is intentionally narrower than a
 * user collapse, width adjustment, or fullscreen toggle, which remain scoped.
 */
function collapseLayoutsForEmptyTerminalSet(
  state: Pick<
    LandingTerminalStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
): Pick<
  LandingTerminalStoreState,
  "layoutsByLandingPageId" | "fallbackLayout"
> {
  const layoutsByLandingPageId: Partial<Record<string, LandingTerminalLayout>> =
    {};
  for (const [landingPageId, layout] of Object.entries(
    state.layoutsByLandingPageId,
  )) {
    if (layout !== undefined) {
      layoutsByLandingPageId[landingPageId] = { ...layout, panelOpen: false };
    }
  }

  return {
    layoutsByLandingPageId,
    fallbackLayout:
      state.fallbackLayout === null
        ? null
        : { ...state.fallbackLayout, panelOpen: false },
  };
}

function parseLandingTerminalLayouts(
  value: unknown,
): Readonly<Partial<Record<string, LandingTerminalLayout>>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([landingPageId, raw]) => {
      if (landingPageId.trim().length === 0 || !isRecord(raw)) return [];
      return [[landingPageId, parseLandingTerminalLayout(raw)]];
    }),
  );
}

function parseFallbackLayout(
  value: Record<string, unknown>,
): LandingTerminalLayout | null {
  if (isRecord(value.fallbackLayout)) {
    return parseLandingTerminalLayout(value.fallbackLayout);
  }
  if (isRecord(value.layoutsByLandingPageId)) return null;
  if (
    typeof value.panelOpen !== "boolean" &&
    typeof value.panelWidthFraction !== "number" &&
    typeof value.maximized !== "boolean"
  ) {
    return null;
  }
  return parseLandingTerminalLayout(value);
}

function parseLandingTerminalLayout(
  value: Record<string, unknown>,
): LandingTerminalLayout {
  return {
    panelOpen: value.panelOpen === true,
    panelWidthFraction:
      typeof value.panelWidthFraction === "number"
        ? clampLandingTerminalPanelWidthFraction(value.panelWidthFraction)
        : DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
    maximized: value.maximized === true,
  };
}

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

export function hostAcknowledgedTab(
  tab: LandingTerminalTabRef,
  terminal: PlainTerminalProjection,
): LandingTerminalTabRef {
  const view = selectPlainTerminalViewModel(terminal);
  return {
    ...tab,
    sessionId: terminal.record.terminalId,
    hostId: terminal.record.hostId,
    cwd: terminal.record.launch.cwd,
    name: view.displayTitle,
    titleSource: terminal.record.manualTitle === null ? "default" : "manual",
    hostAuthorityAcknowledged: true,
    pendingCreate: false,
    sourceStoreVersion:
      tab.sourceStoreVersion ?? LANDING_TERMINAL_SOURCE_STORE_VERSION,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
