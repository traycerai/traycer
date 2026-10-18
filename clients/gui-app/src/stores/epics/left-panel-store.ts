import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { panelVisibilityOverridesFromValues } from "@/lib/layout/rail";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
// Imported for its module-load side effect, and for that reason only: the
// shipped-key carry (L-49, L-61) reads this store's record RAW, and zustand's
// `persist` rewrites that record through the current `partialize` the moment
// `create()` runs below. Capturing it first has to be strictly earlier than
// this module's body, which an import is and a bootstrap call is not.
import "@/lib/layout/legacy-layout-records";
import { useLayoutStore } from "@/stores/layout/layout-store";
import {
  currentMaxRailNaturalWidthPx,
  useMaxRailNaturalWidthPx,
} from "@/stores/epics/sidebar-rail-width-store";
import {
  isLeftPanelId,
  type LeftPanelId,
  type PanelVisibilityOverrideById,
} from "@/lib/left-panel-ids";
import {
  DEFAULT_SORT_MODE,
  isDefaultSort,
  SORT_DIRECTION,
  type SortDirection,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";

// The two panels that own a root-create affordance and a reparent drop target
// (the chat/agent tree and the artifact tree). Kept as a runtime tuple so DnD
// data guards can validate the `panelId` carried on a `sidebar-reparent-*`
// target without re-listing the slugs.
export const ROOT_CREATE_PANEL_IDS = ["chats", "artifacts"] as const;
export type RootCreatePanelId = (typeof ROOT_CREATE_PANEL_IDS)[number];

// ─── Sidebar panel filters (chats / artifacts) ────────────────────────────
// Persisted per epic because filters describe content, not a single tab's view
// chrome. Only active filters are written back; an inactive ("all"/empty)
// filter restores as the frozen EMPTY_* constant so a reload shows everything
// by default.

export const CHAT_ORIGIN = {
  All: "all",
  Gui: "gui",
  Tui: "tui",
} as const;
export type ChatOriginFilter = (typeof CHAT_ORIGIN)[keyof typeof CHAT_ORIGIN];

export const CHAT_OWNERSHIP = {
  All: "all",
  Mine: "mine",
  Others: "others",
} as const;
export type ChatOwnershipFilter =
  (typeof CHAT_OWNERSHIP)[keyof typeof CHAT_OWNERSHIP];

export const CHAT_ARCHIVE_VISIBILITY = {
  Unarchived: "unarchived",
  Archived: "archived",
  All: "all",
} as const;
export type ChatArchiveVisibility =
  (typeof CHAT_ARCHIVE_VISIBILITY)[keyof typeof CHAT_ARCHIVE_VISIBILITY];
export const DEFAULT_CHAT_ARCHIVE_VISIBILITY =
  CHAT_ARCHIVE_VISIBILITY.Unarchived;

function isChatArchiveVisibility(
  value: unknown,
): value is ChatArchiveVisibility {
  return Object.values(CHAT_ARCHIVE_VISIBILITY).some(
    (visibility) => visibility === value,
  );
}

export const ARTIFACT_READ = {
  All: "all",
  Read: "read",
  Unread: "unread",
} as const;
export type ArtifactReadFilter =
  (typeof ARTIFACT_READ)[keyof typeof ARTIFACT_READ];

export const ARTIFACT_STATUS = {
  Todo: 0,
  InProgress: 1,
  Done: 2,
} as const;
export type ArtifactStatusFilter =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];

export interface ChatFilter {
  readonly origin: ChatOriginFilter;
  readonly ownership: ChatOwnershipFilter;
}

export interface ArtifactFilter {
  /** Allowed status codes (0=Todo, 1=In Progress, 2=Done). Empty = all. */
  readonly statuses: readonly ArtifactStatusFilter[];
  /** Allowed artifact kinds. Empty = all. */
  readonly kinds: readonly EpicArtifactKind[];
  readonly read: ArtifactReadFilter;
}

export const EMPTY_CHAT_FILTER: ChatFilter = Object.freeze({
  origin: CHAT_ORIGIN.All,
  ownership: CHAT_OWNERSHIP.All,
});
export const EMPTY_ARTIFACT_FILTER: ArtifactFilter = Object.freeze({
  statuses: Object.freeze([]),
  kinds: Object.freeze([]),
  read: ARTIFACT_READ.All,
});

export function isChatFilterActive(filter: ChatFilter): boolean {
  return (
    filter.origin !== CHAT_ORIGIN.All || filter.ownership !== CHAT_OWNERSHIP.All
  );
}

export function chatFilterCount(filter: ChatFilter): number {
  return (
    (filter.origin === CHAT_ORIGIN.All ? 0 : 1) +
    (filter.ownership === CHAT_OWNERSHIP.All ? 0 : 1)
  );
}

export function matchesChatOwnershipFilter(
  isOwnedByViewer: boolean,
  ownership: ChatOwnershipFilter,
): boolean {
  if (ownership === CHAT_OWNERSHIP.All) return true;
  return ownership === CHAT_OWNERSHIP.Mine ? isOwnedByViewer : !isOwnedByViewer;
}

export function isArtifactFilterActive(filter: ArtifactFilter): boolean {
  return (
    filter.statuses.length > 0 ||
    filter.kinds.length > 0 ||
    filter.read !== ARTIFACT_READ.All
  );
}

export function artifactFilterCount(filter: ArtifactFilter): number {
  return (
    filter.statuses.length +
    filter.kinds.length +
    (filter.read === ARTIFACT_READ.All ? 0 : 1)
  );
}

// Sort is per-epic per-panel, like the filters above. Only non-default modes
// persist; a default ("Last updated", descending) restores as the shared
// DEFAULT_SORT_MODE so a reload shows the projector's canonical order.
export const EMPTY_CHAT_SORT: SortMode = DEFAULT_SORT_MODE;
export const EMPTY_ARTIFACT_SORT: SortMode = DEFAULT_SORT_MODE;

export function isSortModeActive(mode: SortMode): boolean {
  return !isDefaultSort(mode);
}

function flipDirection(direction: SortDirection): SortDirection {
  return direction === SORT_DIRECTION.Asc
    ? SORT_DIRECTION.Desc
    : SORT_DIRECTION.Asc;
}

function toggleMembership<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value];
}

function getFilterOrEmpty<T>(
  byEpicId: Readonly<Record<string, T>>,
  epicId: string,
  empty: T,
): T {
  return Object.hasOwn(byEpicId, epicId) ? byEpicId[epicId] : empty;
}

export const DEFAULT_LEFT_PANEL_ID: LeftPanelId = "chats";

// ─── Sidebar width (global) ────────────────────────────────────────────────
// One persisted px width shared by every epic tab: the sidebar is a single
// hoisted app-level surface (see `epic-sidebar-column.tsx`), so its width is a
// user layout preference like the rail's own order, not per-tab view chrome.
// Bounds ported from paseo's panel store; the resize handle additionally caps
// the live drag at half the layout row so the canvas always keeps space.
export const DEFAULT_SIDEBAR_WIDTH_PX = 320;
export const MIN_SIDEBAR_WIDTH_PX = 200;
export const MAX_SIDEBAR_WIDTH_PX = 600;

export function clampSidebarWidthPx(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return DEFAULT_SIDEBAR_WIDTH_PX;
  return Math.min(
    MAX_SIDEBAR_WIDTH_PX,
    Math.max(MIN_SIDEBAR_WIDTH_PX, Math.round(widthPx)),
  );
}

/**
 * `MIN_SIDEBAR_WIDTH_PX` widened by whichever mounted tab's rail currently
 * needs the most room (`sidebar-rail-width-store.ts`), capped at the same
 * ceiling a manual drag already respects - a rail with enough panels to
 * outgrow it scrolls internally rather than pushing the sidebar past the
 * width the rest of the layout was sized for.
 */
export function dynamicMinSidebarWidthPx(): number {
  return Math.min(
    MAX_SIDEBAR_WIDTH_PX,
    Math.max(MIN_SIDEBAR_WIDTH_PX, currentMaxRailNaturalWidthPx()),
  );
}

export interface LeftPanelRootCreatePending {
  readonly name: string;
}

export interface LeftPanelAcknowledgedRootCreatePending {
  readonly id: string;
  readonly name: string;
}

type RootCreatePendingByPanel<T> = Readonly<
  Partial<Record<string, Readonly<Partial<Record<RootCreatePanelId, T>>>>>
>;

type PanelSectionCollapsedByPanelId = Readonly<
  Partial<Record<LeftPanelId, boolean>>
>;
type PanelSectionWeightsByPanelId = Readonly<
  Partial<Record<LeftPanelId, number>>
>;

interface LeftPanelStore {
  readonly activePanelIdByTabId: Readonly<Record<string, LeftPanelId>>;
  readonly mainCollapsedByTabId: Readonly<Record<string, boolean>>;
  readonly sidebarWidthPx: number;
  /**
   * Per-section collapse, for a panel that is one of a STACKED PAIR and only
   * then (L-166). A collapsed section hands its space to its partner, so the
   * sidebar body is never empty because of it - which is the defect R5R-01
   * found when the body drew one section and still read this flag. A panel
   * standing alone is never collapsible and draws no chevron; "collapse the
   * sidebar" has one owner in {@link LeftPanelStore.mainCollapsedByTabId}.
   */
  readonly panelSectionCollapsedByPanelId: PanelSectionCollapsedByPanelId;
  /**
   * How a stacked pair splits the body, as a weight per panel.
   *
   * Arbitrary-sum numbers rather than a fraction, and keyed by panel rather
   * than by stack, because that is the shape the SHIPPED build wrote and it is
   * still in users' records: keeping it means a dogfooder who dragged the
   * handle to give Artifacts two thirds of the column gets that split back
   * with no migration at all.
   */
  readonly panelSectionWeightsByPanelId: PanelSectionWeightsByPanelId;
  readonly commentsPanelRevealedByTabId: Readonly<Record<string, boolean>>;
  readonly localRootCreatePendingByEpicPanel: RootCreatePendingByPanel<LeftPanelRootCreatePending>;
  readonly acknowledgedRootCreatePendingByEpicPanel: RootCreatePendingByPanel<LeftPanelAcknowledgedRootCreatePending>;
  readonly chatFilterByEpicId: Readonly<Record<string, ChatFilter>>;
  /**
   * Per-epic archive visibility for the Agents panel. Deliberately NOT a field
   * on {@link ChatFilter}: `isChatFilterActive` drives the visible-id set that
   * `mergeForcedExpanded` force-expands, so folding this in would expand the
   * entire tree whenever the archive view changes.
   */
  readonly chatArchiveVisibilityByEpicId: Readonly<
    Record<string, ChatArchiveVisibility>
  >;
  readonly artifactFilterByEpicId: Readonly<Record<string, ArtifactFilter>>;
  readonly chatSortByEpicId: Readonly<Record<string, SortMode>>;
  readonly artifactSortByEpicId: Readonly<Record<string, SortMode>>;

  readonly getActivePanelId: (tabId: string) => LeftPanelId;
  readonly setActivePanelId: (tabId: string, panelId: LeftPanelId) => void;
  readonly setActivePanelIdAndExpand: (
    tabId: string,
    panelId: LeftPanelId,
  ) => void;
  readonly copyTabState: (sourceTabId: string, targetTabId: string) => void;

  readonly isMainCollapsed: (tabId: string) => boolean;
  readonly setMainCollapsed: (tabId: string, collapsed: boolean) => void;
  readonly toggleMainCollapsed: (tabId: string) => void;
  readonly setSidebarWidthPx: (widthPx: number) => void;
  readonly togglePanelSectionCollapsed: (panelId: LeftPanelId) => void;
  readonly setPanelSectionWeights: (
    weights: ReadonlyArray<{ panelId: LeftPanelId; weight: number }>,
  ) => void;

  readonly isCommentsPanelRevealed: (tabId: string) => boolean;
  readonly revealCommentsPanel: (tabId: string) => void;

  readonly getLocalRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
  ) => LeftPanelRootCreatePending | null;
  readonly setLocalRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
    name: string,
  ) => void;
  readonly clearLocalRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
  ) => void;
  readonly getAcknowledgedRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
  ) => LeftPanelAcknowledgedRootCreatePending | null;
  readonly setAcknowledgedRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
    id: string,
    name: string,
  ) => void;
  readonly clearAcknowledgedRootCreatePending: (
    epicId: string,
    panelId: RootCreatePanelId,
  ) => void;

  readonly setChatOrigin: (epicId: string, origin: ChatOriginFilter) => void;
  readonly setChatOwnership: (
    epicId: string,
    ownership: ChatOwnershipFilter,
  ) => void;
  readonly clearChatFilter: (epicId: string) => void;
  readonly setChatArchiveVisibility: (
    epicId: string,
    visibility: ChatArchiveVisibility,
  ) => void;
  readonly toggleArtifactStatus: (
    epicId: string,
    status: ArtifactStatusFilter,
  ) => void;
  readonly toggleArtifactKind: (epicId: string, kind: EpicArtifactKind) => void;
  readonly setArtifactRead: (epicId: string, read: ArtifactReadFilter) => void;
  readonly clearArtifactFilter: (epicId: string) => void;
  readonly setChatSortField: (epicId: string, field: SortField) => void;
  readonly toggleChatSortDirection: (epicId: string) => void;
  readonly resetChatView: (epicId: string) => void;
  readonly setArtifactSortField: (epicId: string, field: SortField) => void;
  readonly toggleArtifactSortDirection: (epicId: string) => void;
  readonly resetArtifactView: (epicId: string) => void;
}

const PERSIST_KEY = persistKey(STORE_KEYS.leftPanel);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isChatOriginFilter(value: unknown): value is ChatOriginFilter {
  return Object.values(CHAT_ORIGIN).some((origin) => origin === value);
}

function isChatOwnershipFilter(value: unknown): value is ChatOwnershipFilter {
  return Object.values(CHAT_OWNERSHIP).some((ownership) => ownership === value);
}

function normalizeChatFilter(value: unknown): ChatFilter {
  if (!isRecord(value)) return EMPTY_CHAT_FILTER;
  return {
    origin: isChatOriginFilter(value.origin) ? value.origin : CHAT_ORIGIN.All,
    ownership: isChatOwnershipFilter(value.ownership)
      ? value.ownership
      : CHAT_OWNERSHIP.All,
  };
}

/**
 * v2 replaces the binary `chatShowArchivedByEpicId` preference with the full
 * three-state archive visibility model. A legacy `true` meant exactly what
 * `All` means now; absent/false remains the default unarchived-only view.
 *
 * v3 adds ownership to each chat filter. Older origin-only filters retain
 * their origin and default ownership to All.
 */
export function migrateLeftPanelPersistedState(persisted: unknown): unknown {
  if (!isRecord(persisted)) return persisted;
  const chatFilterByEpicId: Record<string, ChatFilter> = {};
  if (isRecord(persisted.chatFilterByEpicId)) {
    for (const [epicId, value] of Object.entries(
      persisted.chatFilterByEpicId,
    )) {
      const filter = normalizeChatFilter(value);
      if (isChatFilterActive(filter)) chatFilterByEpicId[epicId] = filter;
    }
  }
  const archiveVisibilityByEpicId: Record<string, ChatArchiveVisibility> = {};
  if (isRecord(persisted.chatArchiveVisibilityByEpicId)) {
    for (const [epicId, visibility] of Object.entries(
      persisted.chatArchiveVisibilityByEpicId,
    )) {
      if (
        isChatArchiveVisibility(visibility) &&
        visibility !== DEFAULT_CHAT_ARCHIVE_VISIBILITY
      ) {
        archiveVisibilityByEpicId[epicId] = visibility;
      }
    }
  } else if (isRecord(persisted.chatShowArchivedByEpicId)) {
    for (const [epicId, showArchived] of Object.entries(
      persisted.chatShowArchivedByEpicId,
    )) {
      if (showArchived === true) {
        archiveVisibilityByEpicId[epicId] = CHAT_ARCHIVE_VISIBILITY.All;
      }
    }
  }
  const migrated = { ...persisted };
  delete migrated.chatShowArchivedByEpicId;
  migrated.chatFilterByEpicId = chatFilterByEpicId;
  migrated.chatArchiveVisibilityByEpicId = archiveVisibilityByEpicId;
  return migrated;
}

function getPersistedPanelSectionCollapsed(
  collapsedByPanelId: PanelSectionCollapsedByPanelId,
): PanelSectionCollapsedByPanelId {
  return Object.entries(collapsedByPanelId).reduce<
    Partial<Record<LeftPanelId, boolean>>
  >((next, [panelId, collapsed]) => {
    if (isLeftPanelId(panelId) && collapsed) next[panelId] = true;
    return next;
  }, {});
}

function getPersistedActivePanelIds(
  activePanelIdByTabId: Readonly<Record<string, LeftPanelId>>,
): Readonly<Record<string, LeftPanelId>> {
  return Object.entries(activePanelIdByTabId).reduce<
    Record<string, LeftPanelId>
  >((nextActivePanels, [tabId, panelId]) => {
    if (panelId !== "comments") {
      nextActivePanels[tabId] = panelId;
    }
    return nextActivePanels;
  }, {});
}

/**
 * The default shallow merge, except that a tab currently showing the Comments
 * panel keeps showing it.
 *
 * `getPersistedActivePanelIds` deliberately never writes a `"comments"` entry:
 * the Comments panel is a TRANSIENT reveal, opened by following a comment, and
 * a restart is meant to land back on the durable panel underneath. That was
 * harmless while hydration happened once at start-up, because there was no live
 * selection to lose.
 *
 * Cross-window rehydrate broke exactly that assumption. The listener runs this
 * merge against a RUNNING store, so any write from another window - a sidebar
 * resize, a panel reorder - replaced the live map with one that, by
 * construction, cannot contain the Comments entry. The user's open Comments
 * panel silently became Chats because a different window changed its sidebar
 * width.
 *
 * So the persisted map wins for everything it can express, and the one value it
 * cannot express is layered back on from the live state. Only `"comments"` -
 * every other panel id round-trips, so taking those from `current` would be
 * ignoring the remote write this merge exists to apply.
 */
function mergeLeftPanelPersistedState(
  persistedState: unknown,
  currentState: LeftPanelStore,
): LeftPanelStore {
  if (!isRecord(persistedState)) return currentState;
  const merged: LeftPanelStore = { ...currentState, ...persistedState };
  const activePanelIdByTabId: Record<string, LeftPanelId> = {
    ...merged.activePanelIdByTabId,
  };
  for (const [tabId, panelId] of Object.entries(
    currentState.activePanelIdByTabId,
  )) {
    if (panelId === "comments") activePanelIdByTabId[tabId] = panelId;
  }
  return { ...merged, activePanelIdByTabId };
}

function getPersistedMainCollapsedByTabId(
  mainCollapsedByTabId: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
  return Object.entries(mainCollapsedByTabId).reduce<Record<string, boolean>>(
    (nextCollapsedByTabId, [tabId, collapsed]) => {
      if (collapsed) nextCollapsedByTabId[tabId] = true;
      return nextCollapsedByTabId;
    },
    {},
  );
}

// Persist only active filters so localStorage doesn't accumulate empty entries.
function filterActiveByEpic<T>(
  byEpicId: Readonly<Record<string, T>>,
  isActive: (value: T) => boolean,
): Readonly<Record<string, T>> {
  return Object.entries(byEpicId).reduce<Record<string, T>>(
    (acc, [epicId, value]) => {
      if (isActive(value)) acc[epicId] = value;
      return acc;
    },
    {},
  );
}

/**
 * The nine rail regions' show/hide, for this store's OWN activation guard.
 *
 * A read, deliberately not a write: the rail's shape belongs to the layout
 * store and `lib/layout/rail-view.ts` owns the writers (G1-09). What this
 * store still needs to know is which panels a user has switched off, because
 * it must not make one of them the active panel.
 */
function currentPanelVisibilityOverrides(): PanelVisibilityOverrideById {
  const state = useLayoutStore.getState();
  return panelVisibilityOverridesFromValues(
    effectiveLayoutValues(state.basePreset, state.overrides),
  );
}

function setPanelRootPending<T>(
  state: RootCreatePendingByPanel<T>,
  epicId: string,
  panelId: RootCreatePanelId,
  pending: T,
): RootCreatePendingByPanel<T> {
  return {
    ...state,
    [epicId]: {
      ...(state[epicId] ?? {}),
      [panelId]: pending,
    },
  };
}

function clearPanelRootPending<T>(
  state: RootCreatePendingByPanel<T>,
  epicId: string,
  panelId: RootCreatePanelId,
): RootCreatePendingByPanel<T> {
  const currentPanels = state[epicId];
  if (currentPanels === undefined) return state;
  if (!Object.hasOwn(currentPanels, panelId)) return state;
  const nextPanels = { ...currentPanels };
  delete nextPanels[panelId];
  if (Object.keys(nextPanels).length === 0) {
    const nextState = { ...state };
    delete nextState[epicId];
    return nextState;
  }
  return { ...state, [epicId]: nextPanels };
}

function getPanelRootPending<T>(
  state: RootCreatePendingByPanel<T>,
  epicId: string,
  panelId: RootCreatePanelId,
): T | null {
  const currentPanels = state[epicId];
  if (currentPanels === undefined) return null;
  return currentPanels[panelId] ?? null;
}

export const useLeftPanelStore = create<LeftPanelStore>()(
  persist(
    (set, get) => ({
      activePanelIdByTabId: {},
      mainCollapsedByTabId: {},
      sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
      panelSectionCollapsedByPanelId: {},
      panelSectionWeightsByPanelId: {},
      commentsPanelRevealedByTabId: {},
      localRootCreatePendingByEpicPanel: {},
      acknowledgedRootCreatePendingByEpicPanel: {},
      chatFilterByEpicId: {},
      chatArchiveVisibilityByEpicId: {},
      artifactFilterByEpicId: {},
      chatSortByEpicId: {},
      artifactSortByEpicId: {},

      getActivePanelId: (tabId) =>
        get().activePanelIdByTabId[tabId] ?? DEFAULT_LEFT_PANEL_ID,

      setActivePanelId: (tabId, panelId) => {
        set((state) => {
          const current =
            state.activePanelIdByTabId[tabId] ?? DEFAULT_LEFT_PANEL_ID;
          if (current === panelId) return state;
          return {
            activePanelIdByTabId: {
              ...state.activePanelIdByTabId,
              [tabId]: panelId,
            },
          };
        });
      },

      setActivePanelIdAndExpand: (tabId, panelId) => {
        set((state) => {
          // A panel the user explicitly switched off never becomes the active
          // one. Several call sites switch panels FOR the user - activating a
          // comment thread, focusing a tab type - and without this they would
          // point the sidebar at a panel that has no rail icon, leaving the
          // body to fall back to a different panel than the one asked for.
          // Only an explicit `false` blocks: a presence-gated panel that is
          // merely absent is not a user decision, and its own reveal path
          // (`revealCommentsPanel`) makes it visible in the same turn.
          if (currentPanelVisibilityOverrides()[panelId] === false) {
            return state;
          }
          const currentPanelId =
            state.activePanelIdByTabId[tabId] ?? DEFAULT_LEFT_PANEL_ID;
          const currentCollapsed = state.mainCollapsedByTabId[tabId] ?? false;
          // Focusing a panel un-collapses its SECTION too, which is what
          // makes clicking either icon of a stacked pair open the stack with
          // that panel showing (L-167) - and the way back out of a section
          // the user collapsed and then navigated to.
          const sectionCollapsed =
            state.panelSectionCollapsedByPanelId[panelId] ?? false;
          const panelChanged = currentPanelId !== panelId;
          if (!panelChanged && !currentCollapsed && !sectionCollapsed)
            return state;
          return {
            activePanelIdByTabId: panelChanged
              ? { ...state.activePanelIdByTabId, [tabId]: panelId }
              : state.activePanelIdByTabId,
            mainCollapsedByTabId: currentCollapsed
              ? { ...state.mainCollapsedByTabId, [tabId]: false }
              : state.mainCollapsedByTabId,
            panelSectionCollapsedByPanelId: sectionCollapsed
              ? { ...state.panelSectionCollapsedByPanelId, [panelId]: false }
              : state.panelSectionCollapsedByPanelId,
          };
        });
      },

      copyTabState: (sourceTabId, targetTabId) => {
        if (sourceTabId === targetTabId) return;
        set((state) => {
          const sourceActivePanelId =
            state.activePanelIdByTabId[sourceTabId] ?? DEFAULT_LEFT_PANEL_ID;
          const targetActivePanelId =
            state.activePanelIdByTabId[targetTabId] ?? DEFAULT_LEFT_PANEL_ID;
          const sourceMainCollapsed =
            state.mainCollapsedByTabId[sourceTabId] ?? false;
          const targetMainCollapsed =
            state.mainCollapsedByTabId[targetTabId] ?? false;
          const sourceCommentsPanelRevealed =
            state.commentsPanelRevealedByTabId[sourceTabId] ?? false;
          const targetCommentsPanelRevealed =
            state.commentsPanelRevealedByTabId[targetTabId] ?? false;
          const activePanelChanged =
            sourceActivePanelId !== targetActivePanelId;
          const mainCollapseChanged =
            sourceMainCollapsed !== targetMainCollapsed;
          const commentsRevealChanged =
            sourceCommentsPanelRevealed !== targetCommentsPanelRevealed;
          if (
            !activePanelChanged &&
            !mainCollapseChanged &&
            !commentsRevealChanged
          ) {
            return state;
          }
          return {
            activePanelIdByTabId: activePanelChanged
              ? {
                  ...state.activePanelIdByTabId,
                  [targetTabId]: sourceActivePanelId,
                }
              : state.activePanelIdByTabId,
            mainCollapsedByTabId: mainCollapseChanged
              ? {
                  ...state.mainCollapsedByTabId,
                  [targetTabId]: sourceMainCollapsed,
                }
              : state.mainCollapsedByTabId,
            commentsPanelRevealedByTabId: commentsRevealChanged
              ? {
                  ...state.commentsPanelRevealedByTabId,
                  [targetTabId]: sourceCommentsPanelRevealed,
                }
              : state.commentsPanelRevealedByTabId,
          };
        });
      },

      isMainCollapsed: (tabId) => get().mainCollapsedByTabId[tabId] ?? false,

      setMainCollapsed: (tabId, collapsed) => {
        set((state) => {
          const current = state.mainCollapsedByTabId[tabId] ?? false;
          if (current === collapsed) return state;
          return {
            mainCollapsedByTabId: {
              ...state.mainCollapsedByTabId,
              [tabId]: collapsed,
            },
          };
        });
      },

      toggleMainCollapsed: (tabId) => {
        set((state) => ({
          mainCollapsedByTabId: {
            ...state.mainCollapsedByTabId,
            [tabId]: !(state.mainCollapsedByTabId[tabId] ?? false),
          },
        }));
      },

      setSidebarWidthPx: (widthPx) => {
        set((state) => {
          const next = Math.max(
            clampSidebarWidthPx(widthPx),
            dynamicMinSidebarWidthPx(),
          );
          if (next === state.sidebarWidthPx) return state;
          return { sidebarWidthPx: next };
        });
      },

      togglePanelSectionCollapsed: (panelId) => {
        set((state) => ({
          panelSectionCollapsedByPanelId: {
            ...state.panelSectionCollapsedByPanelId,
            [panelId]: !(
              state.panelSectionCollapsedByPanelId[panelId] ?? false
            ),
          },
        }));
      },

      setPanelSectionWeights: (weights) => {
        set((state) => {
          const next = weights.reduce<PanelSectionWeightsByPanelId>(
            (acc, { panelId, weight }) => {
              const rounded = Math.round(weight * 100) / 100;
              if (acc[panelId] === rounded) return acc;
              return { ...acc, [panelId]: rounded };
            },
            state.panelSectionWeightsByPanelId,
          );
          if (next === state.panelSectionWeightsByPanelId) return state;
          return { panelSectionWeightsByPanelId: next };
        });
      },

      isCommentsPanelRevealed: (tabId) =>
        get().commentsPanelRevealedByTabId[tabId] ?? false,

      revealCommentsPanel: (tabId) => {
        set((state) => {
          if (state.commentsPanelRevealedByTabId[tabId]) return state;
          return {
            commentsPanelRevealedByTabId: {
              ...state.commentsPanelRevealedByTabId,
              [tabId]: true,
            },
          };
        });
      },

      getLocalRootCreatePending: (epicId, panelId) =>
        getPanelRootPending(
          get().localRootCreatePendingByEpicPanel,
          epicId,
          panelId,
        ),

      setLocalRootCreatePending: (epicId, panelId, name) => {
        set((state) => {
          const current = getPanelRootPending(
            state.localRootCreatePendingByEpicPanel,
            epicId,
            panelId,
          );
          if (current?.name === name) return state;
          return {
            localRootCreatePendingByEpicPanel: setPanelRootPending(
              state.localRootCreatePendingByEpicPanel,
              epicId,
              panelId,
              { name },
            ),
          };
        });
      },

      clearLocalRootCreatePending: (epicId, panelId) => {
        set((state) => {
          const next = clearPanelRootPending(
            state.localRootCreatePendingByEpicPanel,
            epicId,
            panelId,
          );
          if (next === state.localRootCreatePendingByEpicPanel) return state;
          return { localRootCreatePendingByEpicPanel: next };
        });
      },

      getAcknowledgedRootCreatePending: (epicId, panelId) =>
        getPanelRootPending(
          get().acknowledgedRootCreatePendingByEpicPanel,
          epicId,
          panelId,
        ),

      setAcknowledgedRootCreatePending: (epicId, panelId, id, name) => {
        set((state) => {
          const current = getPanelRootPending(
            state.acknowledgedRootCreatePendingByEpicPanel,
            epicId,
            panelId,
          );
          if (current?.id === id && current.name === name) return state;
          return {
            acknowledgedRootCreatePendingByEpicPanel: setPanelRootPending(
              state.acknowledgedRootCreatePendingByEpicPanel,
              epicId,
              panelId,
              { id, name },
            ),
          };
        });
      },

      clearAcknowledgedRootCreatePending: (epicId, panelId) => {
        set((state) => {
          const next = clearPanelRootPending(
            state.acknowledgedRootCreatePendingByEpicPanel,
            epicId,
            panelId,
          );
          if (next === state.acknowledgedRootCreatePendingByEpicPanel) {
            return state;
          }
          return { acknowledgedRootCreatePendingByEpicPanel: next };
        });
      },

      setChatOrigin: (epicId, origin) => {
        set((state) => {
          const current = normalizeChatFilter(
            getFilterOrEmpty(
              state.chatFilterByEpicId,
              epicId,
              EMPTY_CHAT_FILTER,
            ),
          );
          if (current.origin === origin) return state;
          const nextFilter = { ...current, origin };
          const next = { ...state.chatFilterByEpicId };
          if (isChatFilterActive(nextFilter)) next[epicId] = nextFilter;
          else delete next[epicId];
          return {
            chatFilterByEpicId: next,
          };
        });
      },

      setChatOwnership: (epicId, ownership) => {
        set((state) => {
          const current = normalizeChatFilter(
            getFilterOrEmpty(
              state.chatFilterByEpicId,
              epicId,
              EMPTY_CHAT_FILTER,
            ),
          );
          if (current.ownership === ownership) return state;
          const nextFilter = { ...current, ownership };
          const next = { ...state.chatFilterByEpicId };
          if (isChatFilterActive(nextFilter)) next[epicId] = nextFilter;
          else delete next[epicId];
          return { chatFilterByEpicId: next };
        });
      },

      clearChatFilter: (epicId) => {
        set((state) => {
          if (!Object.hasOwn(state.chatFilterByEpicId, epicId)) return state;
          const next = { ...state.chatFilterByEpicId };
          delete next[epicId];
          return { chatFilterByEpicId: next };
        });
      },

      setChatArchiveVisibility: (epicId, visibility) => {
        set((state) => {
          const current =
            state.chatArchiveVisibilityByEpicId[epicId] ??
            DEFAULT_CHAT_ARCHIVE_VISIBILITY;
          if (current === visibility) return state;
          if (visibility === DEFAULT_CHAT_ARCHIVE_VISIBILITY) {
            // Drop the key so the default view leaves no persisted entry.
            const next = { ...state.chatArchiveVisibilityByEpicId };
            delete next[epicId];
            return { chatArchiveVisibilityByEpicId: next };
          }
          return {
            chatArchiveVisibilityByEpicId: {
              ...state.chatArchiveVisibilityByEpicId,
              [epicId]: visibility,
            },
          };
        });
      },

      toggleArtifactStatus: (epicId, status) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.artifactFilterByEpicId,
            epicId,
            EMPTY_ARTIFACT_FILTER,
          );
          return {
            artifactFilterByEpicId: {
              ...state.artifactFilterByEpicId,
              [epicId]: {
                ...current,
                statuses: toggleMembership(current.statuses, status),
              },
            },
          };
        });
      },

      toggleArtifactKind: (epicId, kind) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.artifactFilterByEpicId,
            epicId,
            EMPTY_ARTIFACT_FILTER,
          );
          return {
            artifactFilterByEpicId: {
              ...state.artifactFilterByEpicId,
              [epicId]: {
                ...current,
                kinds: toggleMembership(current.kinds, kind),
              },
            },
          };
        });
      },

      setArtifactRead: (epicId, read) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.artifactFilterByEpicId,
            epicId,
            EMPTY_ARTIFACT_FILTER,
          );
          if (current.read === read) return state;
          return {
            artifactFilterByEpicId: {
              ...state.artifactFilterByEpicId,
              [epicId]: { ...current, read },
            },
          };
        });
      },

      clearArtifactFilter: (epicId) => {
        set((state) => {
          if (!Object.hasOwn(state.artifactFilterByEpicId, epicId)) {
            return state;
          }
          const next = { ...state.artifactFilterByEpicId };
          delete next[epicId];
          return { artifactFilterByEpicId: next };
        });
      },

      setChatSortField: (epicId, field) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.chatSortByEpicId,
            epicId,
            EMPTY_CHAT_SORT,
          );
          if (current.field === field) return state;
          return {
            chatSortByEpicId: {
              ...state.chatSortByEpicId,
              [epicId]: { ...current, field },
            },
          };
        });
      },

      toggleChatSortDirection: (epicId) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.chatSortByEpicId,
            epicId,
            EMPTY_CHAT_SORT,
          );
          return {
            chatSortByEpicId: {
              ...state.chatSortByEpicId,
              [epicId]: {
                ...current,
                direction: flipDirection(current.direction),
              },
            },
          };
        });
      },

      resetChatView: (epicId) => {
        set((state) => {
          const hasFilter = Object.hasOwn(state.chatFilterByEpicId, epicId);
          const hasArchiveVisibility = Object.hasOwn(
            state.chatArchiveVisibilityByEpicId,
            epicId,
          );
          const hasSort = Object.hasOwn(state.chatSortByEpicId, epicId);
          if (!hasFilter && !hasArchiveVisibility && !hasSort) return state;

          const chatFilterByEpicId = { ...state.chatFilterByEpicId };
          const chatArchiveVisibilityByEpicId = {
            ...state.chatArchiveVisibilityByEpicId,
          };
          const chatSortByEpicId = { ...state.chatSortByEpicId };
          delete chatFilterByEpicId[epicId];
          delete chatArchiveVisibilityByEpicId[epicId];
          delete chatSortByEpicId[epicId];
          return {
            chatFilterByEpicId,
            chatArchiveVisibilityByEpicId,
            chatSortByEpicId,
          };
        });
      },

      setArtifactSortField: (epicId, field) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.artifactSortByEpicId,
            epicId,
            EMPTY_ARTIFACT_SORT,
          );
          if (current.field === field) return state;
          return {
            artifactSortByEpicId: {
              ...state.artifactSortByEpicId,
              [epicId]: { ...current, field },
            },
          };
        });
      },

      toggleArtifactSortDirection: (epicId) => {
        set((state) => {
          const current = getFilterOrEmpty(
            state.artifactSortByEpicId,
            epicId,
            EMPTY_ARTIFACT_SORT,
          );
          return {
            artifactSortByEpicId: {
              ...state.artifactSortByEpicId,
              [epicId]: {
                ...current,
                direction: flipDirection(current.direction),
              },
            },
          };
        });
      },

      resetArtifactView: (epicId) => {
        set((state) => {
          const hasFilter = Object.hasOwn(state.artifactFilterByEpicId, epicId);
          const hasSort = Object.hasOwn(state.artifactSortByEpicId, epicId);
          if (!hasFilter && !hasSort) return state;

          const artifactFilterByEpicId = { ...state.artifactFilterByEpicId };
          const artifactSortByEpicId = { ...state.artifactSortByEpicId };
          delete artifactFilterByEpicId[epicId];
          delete artifactSortByEpicId[epicId];
          return { artifactFilterByEpicId, artifactSortByEpicId };
        });
      },
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      version: 3,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        activePanelIdByTabId: getPersistedActivePanelIds(
          state.activePanelIdByTabId,
        ),
        mainCollapsedByTabId: getPersistedMainCollapsedByTabId(
          state.mainCollapsedByTabId,
        ),
        sidebarWidthPx: state.sidebarWidthPx,
        // Only the collapsed ones, so an expanded section is the absence of a
        // record rather than a `false` in every user's blob.
        panelSectionCollapsedByPanelId: getPersistedPanelSectionCollapsed(
          state.panelSectionCollapsedByPanelId,
        ),
        panelSectionWeightsByPanelId: state.panelSectionWeightsByPanelId,
        chatFilterByEpicId: filterActiveByEpic(
          state.chatFilterByEpicId,
          isChatFilterActive,
        ),
        chatArchiveVisibilityByEpicId: filterActiveByEpic(
          state.chatArchiveVisibilityByEpicId,
          (visibility) => visibility !== DEFAULT_CHAT_ARCHIVE_VISIBILITY,
        ),
        artifactFilterByEpicId: filterActiveByEpic(
          state.artifactFilterByEpicId,
          isArtifactFilterActive,
        ),
        chatSortByEpicId: filterActiveByEpic(
          state.chatSortByEpicId,
          isSortModeActive,
        ),
        artifactSortByEpicId: filterActiveByEpic(
          state.artifactSortByEpicId,
          isSortModeActive,
        ),
      }),
      migrate: (persisted) => migrateLeftPanelPersistedState(persisted),
      merge: mergeLeftPanelPersistedState,
    },
  ),
);

/**
 * Another window's rail change - a reorder, a group, a hidden panel - reaches
 * this one live. The rehydrate runs this store's `migrate` exactly as a start-up
 * hydration does, so a blob written by an older build is still repaired on the
 * way in.
 */
installCrossWindowRehydrate(useLeftPanelStore, PERSIST_KEY);

export const useEpicLeftPanelStore = useLeftPanelStore;

export function useChatFilter(epicId: string): ChatFilter {
  return useLeftPanelStore((s) =>
    getFilterOrEmpty(s.chatFilterByEpicId, epicId, EMPTY_CHAT_FILTER),
  );
}

/** Archive visibility for this epic's Agents panel. */
export function useChatArchiveVisibility(
  epicId: string,
): ChatArchiveVisibility {
  return useLeftPanelStore((state) => {
    const visibility = state.chatArchiveVisibilityByEpicId[epicId];
    return isChatArchiveVisibility(visibility)
      ? visibility
      : DEFAULT_CHAT_ARCHIVE_VISIBILITY;
  });
}

export function useArtifactFilter(epicId: string): ArtifactFilter {
  return useLeftPanelStore((s) =>
    getFilterOrEmpty(s.artifactFilterByEpicId, epicId, EMPTY_ARTIFACT_FILTER),
  );
}

export function useChatSort(epicId: string): SortMode {
  return useLeftPanelStore((s) =>
    getFilterOrEmpty(s.chatSortByEpicId, epicId, EMPTY_CHAT_SORT),
  );
}

export function useArtifactSort(epicId: string): SortMode {
  return useLeftPanelStore((s) =>
    getFilterOrEmpty(s.artifactSortByEpicId, epicId, EMPTY_ARTIFACT_SORT),
  );
}

export function useActiveLeftPanelId(tabId: string): LeftPanelId {
  return useLeftPanelStore(
    (s) => s.activePanelIdByTabId[tabId] ?? DEFAULT_LEFT_PANEL_ID,
  );
}

/**
 * Both members of a new pair drawn open (L-170).
 *
 * Called wherever a join is MADE - the inspector's row action and the rail's
 * combine drop - rather than wherever one is broken, because that is the one
 * moment the rule can be stated as a fact about the result: a new stack opens
 * with both sections showing.
 *
 * It matters because the flag outlives the pair. While two panels are apart
 * neither draws a chevron, so a collapse recorded inside an old pair has no
 * control that could clear it and would otherwise come back, persisted, on a
 * rejoin the user made days later.
 */
export function expandJoinedPanelSections(
  first: LeftPanelId,
  second: LeftPanelId,
): void {
  useLeftPanelStore.setState((state) => {
    const collapsed = state.panelSectionCollapsedByPanelId;
    if (collapsed[first] !== true && collapsed[second] !== true) {
      return state;
    }
    return {
      panelSectionCollapsedByPanelId: {
        ...collapsed,
        [first]: false,
        [second]: false,
      },
    };
  });
}

export function useMainPanelCollapsed(tabId: string): boolean {
  return useLeftPanelStore((s) => s.mainCollapsedByTabId[tabId] ?? false);
}

export function useSidebarWidthPx(): number {
  return useLeftPanelStore((s) => s.sidebarWidthPx);
}

/** Reactive counterpart of {@link dynamicMinSidebarWidthPx}. */
export function useMinSidebarWidthPx(): number {
  return Math.min(
    MAX_SIDEBAR_WIDTH_PX,
    Math.max(MIN_SIDEBAR_WIDTH_PX, useMaxRailNaturalWidthPx()),
  );
}

export function useCommentsPanelRevealed(tabId: string): boolean {
  return useLeftPanelStore(
    (s) => s.commentsPanelRevealedByTabId[tabId] ?? false,
  );
}

export function useLocalRootCreatePending(
  epicId: string,
  panelId: RootCreatePanelId,
): LeftPanelRootCreatePending | null {
  return useLeftPanelStore(
    (s) => s.localRootCreatePendingByEpicPanel[epicId]?.[panelId] ?? null,
  );
}

export function useAcknowledgedRootCreatePending(
  epicId: string,
  panelId: RootCreatePanelId,
): LeftPanelAcknowledgedRootCreatePending | null {
  return useLeftPanelStore(
    (s) =>
      s.acknowledgedRootCreatePendingByEpicPanel[epicId]?.[panelId] ?? null,
  );
}
