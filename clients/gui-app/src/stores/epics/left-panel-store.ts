import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  DEFAULT_SORT_MODE,
  isDefaultSort,
  SORT_DIRECTION,
  type SortDirection,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";

export const LEFT_PANEL_IDS = [
  "chats",
  "terminals",
  "artifacts",
  "git-diff",
  "pull-requests",
  "file-tree",
  "sharing",
  "comments",
] as const;

export type LeftPanelId = (typeof LEFT_PANEL_IDS)[number];

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
});
export const EMPTY_ARTIFACT_FILTER: ArtifactFilter = Object.freeze({
  statuses: Object.freeze([]),
  kinds: Object.freeze([]),
  read: ARTIFACT_READ.All,
});

export function isChatFilterActive(filter: ChatFilter): boolean {
  return filter.origin !== CHAT_ORIGIN.All;
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
// user layout preference like the rail grouping, not per-tab view chrome.
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

export const DEFAULT_LEFT_PANEL_GROUPS: ReadonlyArray<LeftPanelGroup> = [
  { panelIds: ["chats", "artifacts"] },
  { panelIds: ["terminals"] },
  { panelIds: ["git-diff"] },
  { panelIds: ["pull-requests"] },
  { panelIds: ["file-tree"] },
  { panelIds: ["sharing"] },
  { panelIds: ["comments"] },
];

export interface LeftPanelRootCreatePending {
  readonly name: string;
}

export interface LeftPanelAcknowledgedRootCreatePending {
  readonly id: string;
  readonly name: string;
}

export interface LeftPanelGroup {
  readonly panelIds: ReadonlyArray<LeftPanelId>;
}

type RootCreatePendingByPanel<T> = Readonly<
  Partial<Record<string, Readonly<Partial<Record<RootCreatePanelId, T>>>>>
>;
type PanelSectionCollapsedByPanelId = Readonly<
  Partial<Record<LeftPanelId, boolean>>
>;
export type PanelVisibilityOverrideById = Readonly<
  Partial<Record<LeftPanelId, boolean>>
>;
type PanelSectionWeightsByPanelId = Readonly<
  Partial<Record<LeftPanelId, number>>
>;

interface LeftPanelStore {
  readonly activePanelIdByTabId: Readonly<Record<string, LeftPanelId>>;
  readonly panelGroups: ReadonlyArray<LeftPanelGroup>;
  readonly mainCollapsedByTabId: Readonly<Record<string, boolean>>;
  readonly sidebarWidthPx: number;
  readonly panelSectionCollapsedByPanelId: PanelSectionCollapsedByPanelId;
  readonly panelSectionWeightsByPanelId: PanelSectionWeightsByPanelId;
  readonly commentsPanelRevealedByTabId: Readonly<Record<string, boolean>>;
  /**
   * Explicit show/hide chosen from the rail context menu, keyed by panel. An
   * entry wins over the panel's own availability rule: `true` keeps the icon in
   * the rail even when the rule would drop it (a PR-less epic, an artifact with
   * no comments), `false` hides a panel that would otherwise be there. An
   * absent entry means "follow the rule", which is why the map is sparse rather
   * than a full record - see `isLeftPanelVisible`.
   *
   * Global (not per tab or per epic) because it expresses a durable preference
   * about the rail's shape, the same way `panelGroups` does: hiding a panel in
   * one epic should not have to be repeated in the next.
   */
  readonly panelVisibilityOverrideById: PanelVisibilityOverrideById;
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
  readonly getPanelGroups: () => ReadonlyArray<LeftPanelGroup>;
  /**
   * Atomic panel-groups write for the rail/section DnD commit layer: callers
   * resolve the next groups with the pure `moveLeftPanel*` helpers (see
   * `resolveLeftPanelGroupsForDrop` in `root-dnd-commits.ts`) and apply the
   * result here. Normalizes the input and keeps slice identity when the
   * result is structurally unchanged.
   */
  readonly applyPanelGroups: (
    nextGroups: ReadonlyArray<LeftPanelGroup>,
  ) => void;

  readonly isMainCollapsed: (tabId: string) => boolean;
  readonly setMainCollapsed: (tabId: string, collapsed: boolean) => void;
  readonly toggleMainCollapsed: (tabId: string) => void;
  readonly setSidebarWidthPx: (widthPx: number) => void;
  readonly isPanelSectionCollapsed: (panelId: LeftPanelId) => boolean;
  readonly setPanelSectionCollapsed: (
    panelId: LeftPanelId,
    collapsed: boolean,
  ) => void;
  readonly togglePanelSectionCollapsed: (panelId: LeftPanelId) => void;
  readonly setPanelSectionWeights: (
    weights: ReadonlyArray<{ panelId: LeftPanelId; weight: number }>,
  ) => void;

  readonly isCommentsPanelRevealed: (tabId: string) => boolean;
  readonly revealCommentsPanel: (tabId: string) => void;

  /**
   * `null` drops the override so the panel goes back to following its own
   * availability rule. Callers pass `null` whenever the value they are setting
   * already matches that rule, keeping the persisted map to real preferences.
   */
  readonly setPanelVisibilityOverride: (
    panelId: LeftPanelId,
    override: boolean | null,
  ) => void;
  readonly clearPanelVisibilityOverrides: () => void;

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

function isLeftPanelId(value: unknown): value is LeftPanelId {
  return LEFT_PANEL_IDS.some((panelId) => panelId === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * v2 replaces the binary `chatShowArchivedByEpicId` preference with the full
 * three-state archive visibility model. A legacy `true` meant exactly what
 * `All` means now; absent/false remains the default unarchived-only view.
 */
export function migrateLeftPanelPersistedState(persisted: unknown): unknown {
  if (!isRecord(persisted)) return persisted;
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
  migrated.chatArchiveVisibilityByEpicId = archiveVisibilityByEpicId;
  return migrated;
}

function isPersistedPanelGroupShape(
  value: unknown,
): value is { readonly panelIds: ReadonlyArray<unknown> } {
  if (!isRecord(value)) return false;
  return Array.isArray(value.panelIds);
}

/**
 * Sidebar grouping as some build of the app wrote it. Only structure is
 * rejected here; an id this build does not know is dropped, and the group with
 * it once nothing is left in it.
 *
 * Removing a panel has to be as gentle as adding one. Rejecting the whole
 * value over one unknown id sends a user who had ever rearranged their sidebar
 * straight back to defaults on the release that retires a panel - and every
 * such user carries the retired id, because it shipped in the defaults.
 */
function readPersistedPanelGroups(
  value: unknown,
): ReadonlyArray<LeftPanelGroup> | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isPersistedPanelGroupShape)) return null;
  return value.flatMap((group) => {
    const panelIds = group.panelIds.filter(isLeftPanelId);
    return panelIds.length === 0 ? [] : [{ panelIds }];
  });
}

function getPersistedPanelSectionCollapsedByPanelId(
  panelSectionCollapsedByPanelId: PanelSectionCollapsedByPanelId,
): PanelSectionCollapsedByPanelId {
  return Object.entries(panelSectionCollapsedByPanelId).reduce<
    Partial<Record<LeftPanelId, boolean>>
  >((nextPanelState, [panelId, collapsed]) => {
    if (isLeftPanelId(panelId) && collapsed) {
      nextPanelState[panelId] = true;
    }
    return nextPanelState;
  }, {});
}

/**
 * Drop entries a newer/older build (or a hand-edited localStorage) could have
 * left behind: an unknown panel id, or a non-boolean where the override map
 * only ever holds `true`/`false`.
 */
function getPersistedPanelVisibilityOverrides(
  panelVisibilityOverrideById: PanelVisibilityOverrideById,
): PanelVisibilityOverrideById {
  return Object.entries(panelVisibilityOverrideById).reduce<
    Partial<Record<LeftPanelId, boolean>>
  >((nextOverrides, [panelId, visible]) => {
    if (isLeftPanelId(panelId) && typeof visible === "boolean") {
      nextOverrides[panelId] = visible;
    }
    return nextOverrides;
  }, {});
}

// `normalizeLeftPanelGroups` returns its input untouched only when the stored
// value is ALREADY normalized; otherwise it builds a new array. Persisted
// groups written before a panel id existed can never be already-normalized -
// the missing group is appended on every call - so the uncached function
// returns a different reference each time it runs.
//
// `useLeftPanelGroups` feeds that value straight into `useSyncExternalStore`,
// and zustand v5 calls `getSnapshot` as `() => selector(getState())` with no
// memoization of its own. An unstable reference therefore reads as "the store
// changed" on every commit, so React re-renders forever and throws "Maximum
// update depth exceeded" (minified error #185) - which is what every user
// carrying pre-Pull-Requests sidebar state hit on opening an epic.
//
// Keyed by the stored array's identity rather than held as ONE last-input
// slot: a single slot only guarantees stability while every reader passes the
// same input, so two readers alternating between two identities (a rehydrated
// persisted array and the live slice, say) would each miss and hand
// `useSyncExternalStore` a fresh array on every commit again - the exact
// condition above. A WeakMap keeps every observed input stable and lets the
// entry die with the array it belongs to.
const storedPanelGroupsCache = new WeakMap<
  object,
  ReadonlyArray<LeftPanelGroup>
>();

function normalizeStoredPanelGroups(
  groups: unknown,
): ReadonlyArray<LeftPanelGroup> {
  const storedGroups = readPersistedPanelGroups(groups);
  return storedGroups === null
    ? DEFAULT_LEFT_PANEL_GROUPS
    : normalizeLeftPanelGroups(storedGroups);
}

function getStoredPanelGroups(groups: unknown): ReadonlyArray<LeftPanelGroup> {
  // A non-object input cannot key a WeakMap, but it also cannot be normalized
  // to anything but the default constant, which is already a stable reference.
  if (typeof groups !== "object" || groups === null) {
    return normalizeStoredPanelGroups(groups);
  }
  const cached = storedPanelGroupsCache.get(groups);
  if (cached !== undefined) return cached;
  const normalizedGroups = normalizeStoredPanelGroups(groups);
  storedPanelGroupsCache.set(groups, normalizedGroups);
  return normalizedGroups;
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

function getPersistedPanelGroups(
  groups: ReadonlyArray<LeftPanelGroup>,
): ReadonlyArray<LeftPanelGroup> {
  return normalizeLeftPanelGroups(groups);
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

function findPanelGroupIndex(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): number {
  return groups.findIndex((group) => group.panelIds.includes(panelId));
}

function findPanelLocation(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): { readonly groupIndex: number; readonly panelIndex: number } | null {
  const groupIndex = findPanelGroupIndex(groups, panelId);
  if (groupIndex < 0) return null;
  const panelIndex = groups[groupIndex].panelIds.indexOf(panelId);
  if (panelIndex < 0) return null;
  return { groupIndex, panelIndex };
}

export function areLeftPanelGroupsEqual(
  left: ReadonlyArray<LeftPanelGroup>,
  right: ReadonlyArray<LeftPanelGroup>,
): boolean {
  return (
    left.length === right.length &&
    left.every((group, groupIndex) => {
      const rightGroup = right[groupIndex];
      return (
        group.panelIds.length === rightGroup.panelIds.length &&
        group.panelIds.every(
          (panelId, panelIndex) => rightGroup.panelIds[panelIndex] === panelId,
        )
      );
    })
  );
}

export function updateLeftPanelGroups(
  currentGroups: ReadonlyArray<LeftPanelGroup>,
  nextGroups: ReadonlyArray<LeftPanelGroup>,
): ReadonlyArray<LeftPanelGroup> {
  if (nextGroups === currentGroups) return currentGroups;
  if (areLeftPanelGroupsEqual(nextGroups, currentGroups)) return currentGroups;
  return nextGroups;
}

function setPanelGroupsState(
  currentGroups: ReadonlyArray<LeftPanelGroup>,
  nextGroups: ReadonlyArray<LeftPanelGroup>,
): Pick<LeftPanelStore, "panelGroups"> | null {
  const updatedGroups = updateLeftPanelGroups(currentGroups, nextGroups);
  if (updatedGroups === currentGroups) return null;
  return { panelGroups: updatedGroups };
}

function normalizeLeftPanelGroups(
  groups: ReadonlyArray<LeftPanelGroup>,
): ReadonlyArray<LeftPanelGroup> {
  const seen = new Set<LeftPanelId>();
  const nextGroups = groups.flatMap((group) => {
    const panelIds = group.panelIds.filter((panelId) => {
      if (!isLeftPanelId(panelId)) return false;
      if (seen.has(panelId)) return false;
      seen.add(panelId);
      return true;
    });
    return panelIds.length === 0 ? [] : [{ panelIds }];
  });
  const missingGroups = LEFT_PANEL_IDS.flatMap((panelId) =>
    seen.has(panelId) ? [] : [{ panelIds: [panelId] }],
  );
  const normalizedGroups = [...nextGroups, ...missingGroups];
  const alreadyNormalized =
    missingGroups.length === 0 &&
    normalizedGroups.length === groups.length &&
    normalizedGroups.every((group, groupIndex) => {
      const originalGroup = groups[groupIndex];
      return (
        group.panelIds.length === originalGroup.panelIds.length &&
        group.panelIds.every(
          (panelId, panelIndex) =>
            originalGroup.panelIds[panelIndex] === panelId,
        )
      );
    });
  return alreadyNormalized ? groups : normalizedGroups;
}

export function moveLeftPanelGroup(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: "before" | "after" | "combine",
): ReadonlyArray<LeftPanelGroup> {
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  const targetIndex = findPanelGroupIndex(normalizedGroups, targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return normalizedGroups;
  if (sourceIndex === targetIndex) return normalizedGroups;

  const sourceGroup = normalizedGroups[sourceIndex];
  const targetGroup = normalizedGroups[targetIndex];
  const groupsWithoutSource = normalizedGroups.filter(
    (_group, index) => index !== sourceIndex,
  );
  const adjustedTargetIndex =
    sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;

  if (position === "combine") {
    return groupsWithoutSource.map((group, index) =>
      index === adjustedTargetIndex
        ? {
            panelIds: [...targetGroup.panelIds, ...sourceGroup.panelIds],
          }
        : group,
    );
  }

  const insertIndex =
    position === "before" ? adjustedTargetIndex : adjustedTargetIndex + 1;
  return [
    ...groupsWithoutSource.slice(0, insertIndex),
    sourceGroup,
    ...groupsWithoutSource.slice(insertIndex),
  ];
}

export function moveLeftPanelGroupToEnd(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  if (sourceIndex < 0 || sourceIndex === normalizedGroups.length - 1) {
    return normalizedGroups;
  }
  const sourceGroup = normalizedGroups[sourceIndex];
  return [
    ...normalizedGroups.filter((_group, index) => index !== sourceIndex),
    sourceGroup,
  ];
}

function removePanelFromGroups(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  return groups.flatMap((group) => {
    const panelIds = group.panelIds.filter(
      (panelId) => panelId !== sourcePanelId,
    );
    return panelIds.length === 0 ? [] : [{ panelIds }];
  });
}

function insertPanelIdsAtPanelPosition(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelIds: ReadonlyArray<LeftPanelId>,
  targetPanelId: LeftPanelId,
  position: "before" | "after",
): ReadonlyArray<LeftPanelGroup> | null {
  const targetLocation = findPanelLocation(groups, targetPanelId);
  if (targetLocation === null) return null;
  const targetGroup = groups[targetLocation.groupIndex];
  const insertIndex =
    position === "before"
      ? targetLocation.panelIndex
      : targetLocation.panelIndex + 1;
  const nextPanelIds = [
    ...targetGroup.panelIds.slice(0, insertIndex),
    ...panelIds,
    ...targetGroup.panelIds.slice(insertIndex),
  ];
  return groups.map((group, index) =>
    index === targetLocation.groupIndex ? { panelIds: nextPanelIds } : group,
  );
}

export function moveLeftPanelToGroup(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  if (sourcePanelId === targetPanelId) return normalizeLeftPanelGroups(groups);
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  const targetIndex = findPanelGroupIndex(normalizedGroups, targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return normalizedGroups;
  if (sourceIndex === targetIndex) return normalizedGroups;
  const groupsWithoutSource = removePanelFromGroups(
    normalizedGroups,
    sourcePanelId,
  );
  const targetIndexAfterRemoval = findPanelGroupIndex(
    groupsWithoutSource,
    targetPanelId,
  );
  if (targetIndexAfterRemoval < 0) return normalizedGroups;

  return groupsWithoutSource.map((group, index) =>
    index === targetIndexAfterRemoval
      ? { panelIds: [...group.panelIds, sourcePanelId] }
      : group,
  );
}

export function moveLeftPanelGroupToPanelPosition(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: "before" | "after",
): ReadonlyArray<LeftPanelGroup> {
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  const targetIndex = findPanelGroupIndex(normalizedGroups, targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return normalizedGroups;
  if (sourceIndex === targetIndex) return normalizedGroups;
  const sourceGroup = normalizedGroups[sourceIndex];
  return (
    insertPanelIdsAtPanelPosition(
      normalizedGroups.filter((_group, index) => index !== sourceIndex),
      sourceGroup.panelIds,
      targetPanelId,
      position,
    ) ?? normalizedGroups
  );
}

export function moveLeftPanelToPanelPosition(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: "before" | "after",
): ReadonlyArray<LeftPanelGroup> {
  if (sourcePanelId === targetPanelId) return normalizeLeftPanelGroups(groups);
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  const targetIndex = findPanelGroupIndex(normalizedGroups, targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return normalizedGroups;
  return (
    insertPanelIdsAtPanelPosition(
      removePanelFromGroups(normalizedGroups, sourcePanelId),
      [sourcePanelId],
      targetPanelId,
      position,
    ) ?? normalizedGroups
  );
}

export function moveLeftPanelToGroupPosition(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: "before" | "after",
): ReadonlyArray<LeftPanelGroup> {
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  const targetIndex = findPanelGroupIndex(normalizedGroups, targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return normalizedGroups;
  const sourceGroup = normalizedGroups[sourceIndex];
  if (sourcePanelId === targetPanelId && sourceGroup.panelIds.length === 1) {
    return normalizedGroups;
  }
  const groupsWithoutSource = removePanelFromGroups(
    normalizedGroups,
    sourcePanelId,
  );
  const targetIndexAfterRemoval =
    sourcePanelId === targetPanelId
      ? sourceIndex
      : findPanelGroupIndex(groupsWithoutSource, targetPanelId);
  if (targetIndexAfterRemoval < 0) return normalizedGroups;
  if (targetIndexAfterRemoval >= groupsWithoutSource.length) {
    return [...groupsWithoutSource, { panelIds: [sourcePanelId] }];
  }
  const insertIndex =
    position === "before"
      ? targetIndexAfterRemoval
      : targetIndexAfterRemoval + 1;
  return [
    ...groupsWithoutSource.slice(0, insertIndex),
    { panelIds: [sourcePanelId] },
    ...groupsWithoutSource.slice(insertIndex),
  ];
}

export function moveLeftPanelToEnd(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  const normalizedGroups = normalizeLeftPanelGroups(groups);
  const sourceIndex = findPanelGroupIndex(normalizedGroups, sourcePanelId);
  if (sourceIndex < 0) return normalizedGroups;
  const sourceGroup = normalizedGroups[sourceIndex];
  if (
    sourceIndex === normalizedGroups.length - 1 &&
    sourceGroup.panelIds.length === 1
  ) {
    return normalizedGroups;
  }
  return [
    ...removePanelFromGroups(normalizedGroups, sourcePanelId),
    { panelIds: [sourcePanelId] },
  ];
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
      panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
      mainCollapsedByTabId: {},
      sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
      panelSectionCollapsedByPanelId: {},
      panelSectionWeightsByPanelId: {},
      commentsPanelRevealedByTabId: {},
      panelVisibilityOverrideById: {},
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
          if (state.panelVisibilityOverrideById[panelId] === false) {
            return state;
          }
          const currentPanelId =
            state.activePanelIdByTabId[tabId] ?? DEFAULT_LEFT_PANEL_ID;
          const currentCollapsed = state.mainCollapsedByTabId[tabId] ?? false;
          const currentSectionCollapsed =
            state.panelSectionCollapsedByPanelId[panelId] ?? false;
          const panelChanged = currentPanelId !== panelId;
          const collapseChanged = currentCollapsed;
          const sectionCollapseChanged = currentSectionCollapsed;
          if (!panelChanged && !collapseChanged && !sectionCollapseChanged) {
            return state;
          }
          return {
            activePanelIdByTabId: panelChanged
              ? { ...state.activePanelIdByTabId, [tabId]: panelId }
              : state.activePanelIdByTabId,
            mainCollapsedByTabId: collapseChanged
              ? { ...state.mainCollapsedByTabId, [tabId]: false }
              : state.mainCollapsedByTabId,
            panelSectionCollapsedByPanelId: sectionCollapseChanged
              ? {
                  ...state.panelSectionCollapsedByPanelId,
                  [panelId]: false,
                }
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

      getPanelGroups: () => getStoredPanelGroups(get().panelGroups),

      applyPanelGroups: (nextGroups) => {
        set((state) => {
          const currentGroups = getStoredPanelGroups(state.panelGroups);
          const normalizedNextGroups = normalizeLeftPanelGroups(nextGroups);
          return (
            setPanelGroupsState(currentGroups, normalizedNextGroups) ?? state
          );
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
          const next = clampSidebarWidthPx(widthPx);
          if (next === state.sidebarWidthPx) return state;
          return { sidebarWidthPx: next };
        });
      },

      isPanelSectionCollapsed: (panelId) =>
        get().panelSectionCollapsedByPanelId[panelId] ?? false,

      setPanelSectionCollapsed: (panelId, collapsed) => {
        set((state) => {
          const current =
            state.panelSectionCollapsedByPanelId[panelId] ?? false;
          if (current === collapsed) return state;
          return {
            panelSectionCollapsedByPanelId: {
              ...state.panelSectionCollapsedByPanelId,
              [panelId]: collapsed,
            },
          };
        });
      },

      togglePanelSectionCollapsed: (panelId) => {
        set((state) => {
          const current =
            state.panelSectionCollapsedByPanelId[panelId] ?? false;
          return {
            panelSectionCollapsedByPanelId: {
              ...state.panelSectionCollapsedByPanelId,
              [panelId]: !current,
            },
          };
        });
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

      setPanelVisibilityOverride: (panelId, override) => {
        set((state) => {
          const current = state.panelVisibilityOverrideById;
          if (override === null) {
            if (!Object.hasOwn(current, panelId)) return state;
            const next = { ...current };
            delete next[panelId];
            return { panelVisibilityOverrideById: next };
          }
          if (current[panelId] === override) return state;
          return {
            panelVisibilityOverrideById: { ...current, [panelId]: override },
          };
        });
      },

      clearPanelVisibilityOverrides: () => {
        set((state) =>
          Object.keys(state.panelVisibilityOverrideById).length === 0
            ? state
            : { panelVisibilityOverrideById: {} },
        );
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
          const current = getFilterOrEmpty(
            state.chatFilterByEpicId,
            epicId,
            EMPTY_CHAT_FILTER,
          );
          if (current.origin === origin) return state;
          return {
            chatFilterByEpicId: {
              ...state.chatFilterByEpicId,
              [epicId]: { origin },
            },
          };
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
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        activePanelIdByTabId: getPersistedActivePanelIds(
          state.activePanelIdByTabId,
        ),
        panelGroups: getPersistedPanelGroups(state.panelGroups),
        sidebarWidthPx: state.sidebarWidthPx,
        panelSectionCollapsedByPanelId:
          getPersistedPanelSectionCollapsedByPanelId(
            state.panelSectionCollapsedByPanelId,
          ),
        panelSectionWeightsByPanelId: state.panelSectionWeightsByPanelId,
        panelVisibilityOverrideById: getPersistedPanelVisibilityOverrides(
          state.panelVisibilityOverrideById,
        ),
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
    },
  ),
);

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

export function useLeftPanelGroups(): ReadonlyArray<LeftPanelGroup> {
  return useLeftPanelStore((s) => getStoredPanelGroups(s.panelGroups));
}

export function useMainPanelCollapsed(tabId: string): boolean {
  return useLeftPanelStore((s) => s.mainCollapsedByTabId[tabId] ?? false);
}

export function useSidebarWidthPx(): number {
  return useLeftPanelStore((s) => s.sidebarWidthPx);
}

export function useLeftPanelSectionCollapsed(panelId: LeftPanelId): boolean {
  return useLeftPanelStore(
    (s) => s.panelSectionCollapsedByPanelId[panelId] ?? false,
  );
}

export function useCommentsPanelRevealed(tabId: string): boolean {
  return useLeftPanelStore(
    (s) => s.commentsPanelRevealedByTabId[tabId] ?? false,
  );
}

export function usePanelVisibilityOverrides(): PanelVisibilityOverrideById {
  return useLeftPanelStore((s) => s.panelVisibilityOverrideById);
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
