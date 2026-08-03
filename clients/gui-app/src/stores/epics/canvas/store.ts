// This file owns the store interface, the zustand store creation (header-tab
// + canvas actions), and the persistence/desktop-bridge wiring. The
// supporting layers live in sibling modules:
//
// - `canvas-persistence.ts`  persisted-state sanitization
// - `canvas-desktop-projection.ts`  desktop snapshot/patch builders
// - `canvas-title-timers.ts`  title-pending timers + visibility predicates
// - `canvas-selectors.ts`  the selector/hook layer (re-exported below)
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { basePersistOptions, epicCanvasKey } from "@/lib/persist";
import { appLogger } from "@/lib/logger";
import {
  DEFAULT_EPIC_NODE_NAMES,
  type EpicNodeKind,
  type EpicNodeRecord,
} from "@/lib/artifacts/node-display";
import {
  areNestedFocusTargetsEqual,
  getCurrentNestedFocusTarget,
  resolveNestedFocusTarget,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
import { UNTITLED_EPIC_TITLE } from "@/lib/display-title";
import { createEpicName } from "@/lib/epic-name";
import {
  Analytics,
  AnalyticsEvent,
  analyticsArtifactKindForCanvasTileType,
  analyticsTargetForCanvasTileType,
  type AnalyticsSource,
} from "@/lib/analytics";
import type {
  DesktopJsonValue,
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
} from "@/lib/windows/types";
import type { DesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import { useTileScrollAnchorStore } from "@/stores/epics/canvas/tile-scroll-anchor-store";
import { evictChatTabState } from "@/stores/chats/chat-tab-state-cache";
import { evictPendingHydrationRestores } from "@/stores/chats/chat-tab-pending-hydration-restore";
import { flushChatTabViewportHandoff } from "@/stores/chats/chat-tab-viewport-handoff";
import { evictActivityGroupOpenStores } from "@/stores/chats/activity-group-open-store-core";
import { evictA2AOpenStores } from "@/stores/chats/a2a-open-store-context";
import {
  toolOpenInitializedScopes,
  useToolOpenStore,
} from "@/stores/chats/tool-open-store";
import {
  subagentOpenInitializedScopes,
  useSubagentOpenStore,
} from "@/stores/chats/subagent-open-store";
import { evictTileFindUi } from "@/stores/tile-find/tile-find-store";
import { evictChatTurnMinimapActiveEntries } from "@/stores/chats/chat-turn-minimap-active-entry-store";
import { promoteChatTabPersistenceToDurable } from "@/stores/chats/chat-tab-persistence-eviction";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import {
  closeAllTabs,
  closeOtherTabs as closeOtherTileTabs,
  closePane,
  closeRightTabs,
  closeTab as closeTileTab,
  cloneEpicCanvasState,
  createSingleTileCanvas,
  dropOnTabStrip,
  openBlankTabInPane as openBlankTabInPaneCanvas,
  openTile,
  openTileInBackgroundTab as openTileInBackgroundTabCanvas,
  openTileInPane as openTileInPaneCanvas,
  findPaneTabByContentId,
  openSingletonTileInPane as openSingletonTileInPaneCanvas,
  promotePreview,
  renameArtifact,
  renameTerminalTiles,
  restoreTilePreview as restoreTilePreviewCanvas,
  resizeSplit,
  setActivePane,
  setActiveTab as setActiveTileTabCanvas,
  splitPaneAtEdge,
  splitPaneEmpty,
  toggleGitDiffBundleFileCollapsed,
  toggleSnapshotDiffBundleFileCollapsed,
  updateCommGraphTileView,
  updateGitDiffTileView,
  updateSnapshotDiffTileView,
  updatePrDiffTileView,
  togglePrDiffFileCollapsed,
} from "@/stores/epics/canvas/actions";
import {
  EMPTY_CANVAS,
  collectLiveTileInstanceIds,
  createEmptyCanvas,
} from "@/stores/epics/canvas/canvas-state";
import {
  findPaneById,
  paneRemovalDissolveHandoffTargets,
  resolveActivePaneTab,
} from "@/stores/epics/canvas/tile-tree";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
  type EdgeDropPosition,
  type EpicCanvasTileRef,
  type EpicCanvasState,
  type CommGraphTileViewState,
  type EpicViewTab,
  type GitDiffTileViewState,
  type SplitDirection,
  type TilesByInstanceId,
} from "@/stores/epics/canvas/types";
import {
  EMPTY_TREES,
  sanitizePersistedCanvasState,
} from "@/stores/epics/canvas/canvas-persistence";
import {
  buildDesktopProjectionPatch,
  projectCanvasByTabIdForDesktop,
  projectTabsForDesktop,
} from "@/stores/epics/canvas/canvas-desktop-projection";
import { serializeEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import {
  isTabCloseLocked,
  isTabStructurallyLocked,
} from "@/stores/tabs/tab-structural-lock";
import {
  chatTitleTimers,
  clearAllScheduledTitlePending,
  clearScheduledTitlePending,
  epicTitleTimers,
  scheduleTitlePendingClear,
  type PendingTitleEntry,
} from "@/stores/epics/canvas/canvas-title-timers";
import {
  collectTileIdentityRegistry,
  enforceTileIdentityInvariant,
} from "@/stores/epics/canvas/tile-identity-invariant";
export { parseEpicNodeRef as parseArtifactRef } from "@/stores/epics/canvas/tile-schema/artifact-tile";

function trackOpenedCanvasTile(
  node: EpicCanvasTileRef,
  source: AnalyticsSource,
): void {
  if (node.type === "chat") {
    Analytics.getInstance().track(AnalyticsEvent.ChatOpened, {
      source,
    });
    return;
  }
  if (node.type === "terminal" || node.type === "terminal-agent") {
    Analytics.getInstance().track(AnalyticsEvent.TerminalOpened, {
      source,
      kind: node.type === "terminal" ? "shell" : "agent",
    });
    return;
  }
  if (node.type === "workspace-file") {
    Analytics.getInstance().track(AnalyticsEvent.WorkspaceFileOpened, {
      source,
    });
    return;
  }
  if (node.type === "git-diff" || node.type === "snapshot-diff") {
    const bundle =
      node.diff.kind === "bundle" ||
      node.diff.kind === "snapshot-cumulative-bundle";
    Analytics.getInstance().track(AnalyticsEvent.DiffOpened, {
      source,
      scope: bundle ? "all" : "file",
    });
    return;
  }
  const artifactKind = analyticsArtifactKindForCanvasTileType(node.type);
  if (artifactKind !== null) {
    Analytics.getInstance().track(AnalyticsEvent.ArtifactOpened, {
      source,
      kind: artifactKind,
    });
  }
}

/**
 * Emits `tab_closed` for every tile a close GESTURE actually removed, by
 * diffing the tab canvas' tile registry around the update (every close path
 * prunes `tilesByInstanceId`, including last-tab pane collapse). Only the
 * user-facing close actions call this, so programmatic tile removal - e.g. a
 * cross-tab move, which routes through different actions - never counts.
 */
function trackClosedCanvasTiles(
  before: EpicCanvasState | undefined,
  after: EpicCanvasState | undefined,
): void {
  if (before === undefined) return;
  Object.entries(before.tilesByInstanceId).forEach(([instanceId, tile]) => {
    if (tile === undefined) return;
    if (after !== undefined && instanceId in after.tilesByInstanceId) return;
    const target = analyticsTargetForCanvasTileType(tile.type);
    if (target === null) return;
    Analytics.getInstance().track(AnalyticsEvent.TabClosed, { target });
  });
}

export interface TabMoveArgs {
  readonly sourcePaneId: string;
  // Tab instanceId (per-tab identity), not the content id.
  readonly tabId: string;
  readonly targetPaneId: string;
  readonly targetIndex: number;
}

export interface TabSplitArgs {
  readonly sourcePaneId: string;
  // Tab instanceId (per-tab identity), not the content id.
  readonly tabId: string;
  readonly targetPaneId: string;
  readonly position: EdgeDropPosition;
}

export interface ClosedTilePayload {
  readonly node: EpicCanvasTileRef;
  readonly pendingCreate: boolean;
}

export interface EpicCanvasStore {
  /**
   * Durable tab records keyed by tab id. A tab can remain here even when it is
   * not visible in the header strip, which lets reopen restore its canvas.
   */
  readonly tabsById: Readonly<Record<string, EpicViewTab | undefined>>;
  /**
   * Per-tab canvas snapshot, keyed by `tabId`, kept PARALLEL to `tabsById`
   * rather than embedded in the tab record. Canvas mutations (tile open,
   * active-tab switch, split, resize) touch only this map, so the `tabsById`
   * record identity stays stable for tab-metadata consumers (header strip,
   * command palette). Every entry is created/cloned/removed in lockstep with
   * its `tabsById` entry.
   */
  readonly canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>;
  /**
   * Payloads of tiles closed out of a tab's canvas, keyed by `tabId` then by
   * the closed tile's (now-defunct) `instanceId`. Lets back/forward reopen a
   * closed sub-tab as a preview (`openTilePreviewInTab`) even though
   * `tilesByInstanceId` itself discards the payload on close - the href/search
   * params alone don't carry enough to reconstruct a tile node. Session-only
   * (not in `partialize`) and bounded per tab (`captureClosedTilePayloads`),
   * so a stale miss just falls back to the existing stale-route restore.
   */
  readonly closedTilePayloadsByTabId: Readonly<
    Record<
      string,
      Readonly<Record<string, ClosedTilePayload | undefined>> | undefined
    >
  >;
  /**
   * Header-strip order for tabs currently visible in this window. Removing an
   * id from this list closes the visible tab without necessarily discarding its
   * stored canvas state.
   */
  readonly openTabOrder: ReadonlyArray<string>;
  readonly activeTabId: string | null;
  /**
   * Per-epic restore pointer. When reopening an epic, prefer this tab id over
   * creating a fresh tab so duplicate tabs and recent focus behave predictably.
   */
  readonly mostRecentTabIdByEpicId: Readonly<
    Record<string, string | undefined>
  >;
  readonly artifactTreeByEpicId: Readonly<
    Record<string, ReadonlyArray<EpicNodeRecord> | undefined>
  >;
  readonly selfDeletedArtifactIds: ReadonlySet<string>;
  readonly pendingCreateArtifactIds: ReadonlySet<string>;
  readonly preAckRootCreatesByEpic: Readonly<
    Record<string, ReadonlyArray<{ tempId: string; name: string }> | undefined>
  >;
  readonly pendingRootCreatesByEpic: Readonly<
    Record<string, ReadonlyArray<{ id: string; name: string }> | undefined>
  >;
  readonly pendingEpicTitles: Readonly<Record<string, PendingTitleEntry>>;
  readonly pendingChatTitles: Readonly<Record<string, PendingTitleEntry>>;

  openEpicTab: (epicId: string, name: string | undefined) => string;
  /** Coordinator-only stable-id source creation. */
  openEpicTabWithId: (
    tabId: string,
    epicId: string,
    name: string | undefined,
  ) => string;
  /** Coordinator-only stable-id source creation for a Phase migration tab. */
  openPhaseMigrationTabWithId: (
    tabId: string,
    phaseId: string,
    name: string | undefined,
  ) => string;
  /**
   * Open an epic tab in the header strip WITHOUT activating it - the active
   * tab and current route are left untouched. Reuses an existing tab for the
   * epic when one is already open (returns its id, makes no change). Used by
   * the history "Open in Background" action so a row can be opened behind the
   * current surface (e.g. without dismissing the History overlay).
   */
  openEpicTabInBackground: (epicId: string, name: string | undefined) => string;
  /**
   * Close the tab as a user-visible header action: remove it from
   * `openTabOrder`, update active/recent pointers, and keep `tabsById[tabId]`
   * available for reopen. Use `discardTabState` when the tab record must be
   * permanently deleted.
   */
  closeTab: (tabId: string) => void;
  /**
   * Permanently remove all tabs for deleted or inaccessible epics, including
   * hidden preserved tabs that are no longer in `openTabOrder`.
   */
  closeTabsForEpics: (epicIds: ReadonlyArray<string>) => void;
  /**
   * Keep one visible tab in the header strip and hide the rest. Hidden tabs
   * remain in `tabsById` so reopening their epics can restore their canvases.
   */
  closeOtherTabs: (tabId: string) => void;
  moveOpenTab: (tabId: string, targetIndex: number) => void;
  duplicateTab: (tabId: string) => string | null;
  /**
   * Open `node` as the sole tile of a fresh header tab for `epicId`,
   * inserted at `insertIndex` in the header strip (`null` appends). The new
   * tab becomes active. Single store write - callers must not follow up with
   * a `moveOpenTab` to position it.
   */
  openTileInNewTab: (
    epicId: string,
    node: EpicCanvasTileRef,
    insertIndex: number | null,
  ) => string | null;
  tearOffTabIntoNewHeaderTab: (args: {
    readonly sourceTabId: string;
    readonly sourcePaneId: string;
    readonly sourceTileTabId: string;
    readonly insertIndex: number;
  }) => string | null;
  /**
   * Activate an existing tab. If the tab was previously hidden by `closeTab`,
   * reinsert it into `openTabOrder` so it becomes visible again.
   */
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, name: string) => void;
  /**
   * Permanently delete a tab record and its canvas state. This is for true
   * discard flows such as moving a tab to another desktop window or rejecting
   * a duplicate desktop ownership claim.
   */
  discardTabState: (tabId: string) => DesktopPerWindowStatePatch | null;
  /**
   * Resolve the tab to show for an epic. Reuses the active/recent/preserved tab
   * when one exists; otherwise creates a new tab with the provided name.
   */
  resolveTargetTabForEpic: (epicId: string, name: string | undefined) => string;
  /**
   * Return the best existing tab id for an epic using the same active/recent
   * preference as reopen, without creating a new tab.
   */
  resolveTabIdForEpic: (epicId: string) => string | null;

  /**
   * Open a tile in `tabId`'s canvas as a permanent tab (dedup-aware: focuses
   * the tab if the content is already open anywhere). All tile kinds -
   * artifacts, terminals, workspace files, git/snapshot diffs - flow through
   * this one action.
   */
  openTileInTab: (tabId: string, node: EpicCanvasTileRef) => void;
  prepareOpenTileInTabFocusTarget: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  prepareOpenTileInTabFocusTargetFromSource: (
    tabId: string,
    node: EpicCanvasTileRef,
    source: AnalyticsSource,
  ) => NestedFocusTarget | null;
  /**
   * Open a tile in preview mode (italic tab), replacing the destination
   * pane's existing preview. Same dedup as `openTileInTab`.
   */
  openTilePreviewInTab: (tabId: string, node: EpicCanvasTileRef) => void;
  prepareOpenTilePreviewInTabFocusTarget: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  prepareOpenTilePreviewInTabFocusTargetFromSource: (
    tabId: string,
    node: EpicCanvasTileRef,
    source: AnalyticsSource,
  ) => NestedFocusTarget | null;
  /**
   * Reopens a preserved `closedTilePayloadsByTabId` entry as a preview,
   * preferring `preferredPaneId` (the history entry's original pane) when it
   * still exists and falling back to the active pane otherwise. `node` keeps
   * its ORIGINAL `instanceId` (not a fresh one) so a landing history href
   * addressing that exact instanceId resolves directly after the reopen.
   * Evicts the now-live entry from `closedTilePayloadsByTabId` - a later
   * close re-captures it - and restores its pending-create marker while the
   * optimistic record is still projecting. Back/forward's preview-reopen path
   * (`history-navigation.ts`) is the only caller.
   */
  restoreClosedTilePreview: (
    tabId: string,
    preferredPaneId: string | null,
    node: EpicCanvasTileRef,
  ) => void;
  /**
   * Drops one entry from `closedTilePayloadsByTabId` without reopening it.
   * Back/forward's preview-reopen path calls this when a preserved payload's
   * backing record has since been permanently deleted (checked via
   * `isTileRefRecordLive`) - the entry is unusable, so it's discarded and the
   * landing treats it as a cache miss (existing stale-target fallback takes
   * over) rather than resurrecting a tile the record-sync effect would
   * immediately close again.
   */
  discardClosedTilePayload: (tabId: string, instanceId: string) => void;
  /**
   * Add `node` as a tab in the active pane without changing the active
   * tab/pane (persists a server-created terminal as a saved tab without
   * stealing focus). Idempotent.
   */
  openTileInBackgroundTab: (tabId: string, node: EpicCanvasTileRef) => void;
  prepareOpenTileInBackgroundTabFocusTarget: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  prepareOpenTileInBackgroundTabFocusTargetFromSource: (
    tabId: string,
    node: EpicCanvasTileRef,
    source: AnalyticsSource,
  ) => NestedFocusTarget | null;
  /**
   * Opener-only path: open `ref` into the explicit `paneId` as a fresh tab
   * instance, bypassing dedup. A second view of an already-open content id is
   * allowed (distinct `instanceId`). See {@link openTileInPaneCanvas}.
   */
  openTileInPane: (
    tabId: string,
    paneId: string,
    ref: EpicCanvasTileRef,
  ) => void;
  prepareOpenTileInPaneFocusTarget: (
    tabId: string,
    paneId: string,
    ref: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  prepareOpenTileInPaneFocusTargetFromSource: (
    tabId: string,
    paneId: string,
    ref: EpicCanvasTileRef,
    source: AnalyticsSource,
  ) => NestedFocusTarget | null;
  /**
   * Opener path for a SINGLETON tile (one instance per content id, e.g. the
   * per-epic comm graph): focus the existing tab if there is one, otherwise
   * open into `paneId`. See {@link openSingletonTileInPaneCanvas}.
   */
  prepareOpenSingletonTileInPaneFocusTarget: (
    tabId: string,
    paneId: string,
    ref: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  /**
   * Open a blank "New tab" in `paneId`, made active. Reuse-if-active-is-blank:
   * a no-op-ish focus when the pane's active tab is already blank.
   * See {@link openBlankTabInPaneCanvas}.
   */
  openBlankTabInPane: (tabId: string, paneId: string) => void;
  prepareOpenBlankTabInPaneFocusTarget: (
    tabId: string,
    paneId: string,
  ) => NestedFocusTarget | null;
  updateGitDiffTileViewInTab: (
    tabId: string,
    tileId: string,
    view: GitDiffTileViewState,
  ) => void;
  updateSnapshotDiffTileViewInTab: (
    tabId: string,
    tileId: string,
    view: GitDiffTileViewState,
  ) => void;
  updateCommGraphTileViewInTab: (
    tabId: string,
    tileId: string,
    view: CommGraphTileViewState,
  ) => void;
  updatePrDiffTileViewInTab: (
    tabId: string,
    tileId: string,
    view: GitDiffTileViewState,
  ) => void;
  toggleGitDiffBundleFileCollapsedInTab: (
    tabId: string,
    tileId: string,
    filePath: string,
  ) => void;
  toggleSnapshotDiffBundleFileCollapsedInTab: (
    tabId: string,
    tileId: string,
    filePath: string,
  ) => void;
  togglePrDiffFileCollapsedInTab: (
    tabId: string,
    tileId: string,
    filePath: string,
  ) => void;
  promotePreviewInTab: (tabId: string, paneId: string) => void;
  applyNestedRouteFocus: (tabId: string, target: NestedFocusTarget) => void;
  setActiveTileTab: (tabId: string, paneId: string, tileTabId: string) => void;
  prepareSetActiveTileTabFocusTarget: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => NestedFocusTarget | null;
  setActiveTilePane: (tabId: string, paneId: string) => void;
  prepareSetActiveTilePaneFocusTarget: (
    tabId: string,
    paneId: string,
  ) => NestedFocusTarget | null;
  insertNodeOnTabStrip: (
    tabId: string,
    targetPaneId: string,
    targetIndex: number,
    node: EpicCanvasTileRef,
  ) => void;
  prepareInsertNodeOnTabStripFocusTarget: (
    tabId: string,
    targetPaneId: string,
    targetIndex: number,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  moveTabOnTabStrip: (tabId: string, args: TabMoveArgs) => void;
  prepareMoveActiveTabOnTabStripFocusTarget: (
    tabId: string,
    args: TabMoveArgs,
  ) => NestedFocusTarget | null;
  splitPaneWithNode: (
    tabId: string,
    targetPaneId: string,
    position: EdgeDropPosition,
    node: EpicCanvasTileRef,
  ) => void;
  prepareSplitPaneWithNodeFocusTarget: (
    tabId: string,
    targetPaneId: string,
    position: EdgeDropPosition,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  splitPaneWithTab: (tabId: string, args: TabSplitArgs) => void;
  prepareSplitPaneWithTabFocusTarget: (
    tabId: string,
    args: TabSplitArgs,
  ) => NestedFocusTarget | null;
  /**
   * Split into a trailing empty pane. Returns the new empty pane's id (which
   * `splitPaneEmpty` makes active) so callers can bind the opener to it, or
   * `null` when the split was a no-op.
   */
  splitPaneEmptyInTab: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
  ) => string | null;
  prepareSplitPaneEmptyFocusTarget: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
  ) => NestedFocusTarget | null;
  /** Convenience for the explicit far-right split button (horizontal). */
  splitPaneEmptyRightInTab: (
    tabId: string,
    targetPaneId: string,
  ) => string | null;
  closeCanvasTab: (tabId: string, paneId: string, tileTabId: string) => void;
  prepareCloseCanvasTabFocusTarget: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => NestedFocusTarget | null;
  closeOtherCanvasTabs: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => void;
  prepareCloseOtherCanvasTabsFocusTarget: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => NestedFocusTarget | null;
  closeRightCanvasTabs: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => void;
  prepareCloseRightCanvasTabsFocusTarget: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => NestedFocusTarget | null;
  closeAllCanvasTabs: (tabId: string, paneId: string) => void;
  prepareCloseAllCanvasTabsFocusTarget: (
    tabId: string,
    paneId: string,
  ) => NestedFocusTarget | null;
  closeCanvasPane: (tabId: string, paneId: string) => void;
  prepareCloseCanvasPaneFocusTarget: (
    tabId: string,
    paneId: string,
  ) => NestedFocusTarget | null;
  /** Commit a group's child fractions (clamped + normalized) on pointer-up. */
  resizeSplitInTab: (
    tabId: string,
    groupId: string,
    sizes: ReadonlyArray<number>,
  ) => void;
  prepareResizeSplitFocusTarget: (
    tabId: string,
    groupId: string,
    sizes: ReadonlyArray<number>,
  ) => NestedFocusTarget | null;
  renameArtifactInTab: (
    tabId: string,
    artifactId: string,
    name: string,
  ) => void;
  /**
   * Refresh the persisted fallback `name` of every terminal tile bound to
   * (hostId, sessionId) across ALL view tabs after a successful host rename.
   * Durable-snapshot fan-out only - live titles render from the host's
   * `terminal.list` rows.
   */
  updateTerminalNameSnapshots: (
    hostId: string,
    sessionId: string,
    name: string,
  ) => void;

  seedEpic: (
    epicId: string,
    tab: Pick<EpicViewTab, "tabId" | "name">,
    artifacts: ReadonlyArray<EpicNodeRecord>,
  ) => void;
  createEpicFromPrompt: (prompt: string) => {
    epicId: string;
    name: string;
    tabId: string;
  };
  addRootArtifact: (
    tabId: string,
    type: EpicNodeKind,
    hostId: string,
  ) => string;
  addChildArtifact: (
    epicId: string,
    parentId: string,
    type: EpicNodeKind,
    hostId: string,
  ) => string | null;
  markArtifactSelfDeleted: (artifactId: string) => void;
  unmarkArtifactSelfDeleted: (artifactId: string) => void;
  markArtifactPendingCreate: (artifactId: string) => void;
  unmarkArtifactPendingCreate: (artifactId: string) => void;
  beginPreAckRootCreate: (epicId: string, tempId: string, name: string) => void;
  endPreAckRootCreate: (epicId: string, tempId: string) => void;
  registerPendingRootCreate: (
    epicId: string,
    pendingId: string,
    name: string,
  ) => void;
  clearPendingRootCreate: (epicId: string, pendingId: string) => void;
  markEpicTitlePending: (epicId: string, expectedTitle: string) => void;
  clearEpicTitlePending: (epicId: string) => void;
  markChatTitlePending: (chatId: string, expectedTitle: string) => void;
  clearChatTitlePending: (chatId: string) => void;
  clearAllTitleGenerationPending: () => void;
}

export { createEpicName } from "@/lib/epic-name";

let localPersistenceEnabled = true;
let desktopProjectionBridge: DesktopPerWindowProjectionBridge | null = null;
let applyingDesktopProjection = false;
const serializedCanvasByReference = new WeakMap<
  EpicCanvasState,
  DesktopJsonValue
>();

function serializeCanvasForLocalPersist(
  canvas: EpicCanvasState,
): DesktopJsonValue {
  const cached = serializedCanvasByReference.get(canvas);
  if (cached !== undefined) return cached;
  const serialized = serializeEpicCanvasState(canvas);
  serializedCanvasByReference.set(canvas, serialized);
  return serialized;
}

function serializeCanvasByTabIdForLocalPersist(
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
): Readonly<Record<string, DesktopJsonValue>> {
  if (!localPersistenceEnabled) return {};
  return Object.fromEntries(
    Object.entries(canvasByTabId).flatMap(([tabId, canvas]) =>
      canvas === undefined
        ? []
        : [[tabId, serializeCanvasForLocalPersist(canvas)]],
    ),
  );
}

const epicCanvasStorage: StateStorage = {
  getItem: (name) => window.localStorage.getItem(name),
  setItem: (name, value) => {
    if (!localPersistenceEnabled) return;
    window.localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    window.localStorage.removeItem(name);
  },
};

export function setEpicCanvasLocalPersistenceEnabled(enabled: boolean): void {
  localPersistenceEnabled = enabled;
}

export function setEpicCanvasDesktopProjectionBridge(
  bridge: DesktopPerWindowProjectionBridge | null,
): void {
  desktopProjectionBridge = bridge;
  setEpicCanvasLocalPersistenceEnabled(bridge === null);
}

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

function firstTabIdForEpicInState(
  state: Pick<EpicCanvasStore, "openTabOrder" | "tabsById">,
  epicId: string,
): string | null {
  return (
    state.openTabOrder.find(
      (tabId) => state.tabsById[tabId]?.epicId === epicId,
    ) ?? null
  );
}

export function resolveTabIdForEpic(
  state: Pick<
    EpicCanvasStore,
    "activeTabId" | "mostRecentTabIdByEpicId" | "openTabOrder" | "tabsById"
  >,
  epicId: string,
): string | null {
  const activeTab =
    state.activeTabId === null ? null : state.tabsById[state.activeTabId];
  if (activeTab?.epicId === epicId) return activeTab.tabId;
  const recentId = state.mostRecentTabIdByEpicId[epicId];
  if (recentId !== undefined && state.tabsById[recentId]?.epicId === epicId) {
    return recentId;
  }
  return firstTabIdForEpicInState(state, epicId);
}

export function resolveTabIdForPhaseMigration(
  state: Pick<EpicCanvasStore, "tabsById">,
  phaseId: string,
): string | null {
  const tab = Object.values(state.tabsById).find(
    (candidate) =>
      candidate?.surfaceMode?.kind === "phase-migration" &&
      candidate.surfaceMode.phaseId === phaseId,
  );
  return tab?.tabId ?? null;
}

function createEpicViewTab(
  epicId: string,
  name: string | undefined,
): EpicViewTab {
  return { tabId: uuidv4(), epicId, name: name ?? UNTITLED_EPIC_TITLE };
}

/**
 * Shared `set()` payload for appending a freshly-created epic tab to the strip:
 * registers the tab + an empty canvas, pushes it onto `openTabOrder`, points
 * the epic's most-recent pointer at it, and seeds an empty artifact tree if the
 * epic has none. Activation is layered on by the caller (`openEpicTab` makes it
 * active; `openEpicTabInBackground` leaves `activeTabId` untouched).
 */
function appendedEpicTabState(state: EpicCanvasStore, tab: EpicViewTab) {
  const { tabId, epicId } = tab;
  return {
    tabsById: { ...state.tabsById, [tabId]: tab },
    canvasByTabId: { ...state.canvasByTabId, [tabId]: createEmptyCanvas() },
    openTabOrder: [...state.openTabOrder, tabId],
    mostRecentTabIdByEpicId: {
      ...state.mostRecentTabIdByEpicId,
      [epicId]: tabId,
    },
    artifactTreeByEpicId:
      epicId in state.artifactTreeByEpicId
        ? state.artifactTreeByEpicId
        : { ...state.artifactTreeByEpicId, [epicId]: [] },
  };
}

function epicTabNames(
  tabsById: Readonly<Record<string, EpicViewTab | undefined>>,
  epicId: string,
): ReadonlyArray<string> {
  return Object.values(tabsById).flatMap((tab) =>
    tab !== undefined && tab.epicId === epicId ? [tab.name] : [],
  );
}

function withoutTabIds(
  record: Readonly<Record<string, EpicViewTab | undefined>>,
  ids: ReadonlySet<string>,
): Readonly<Record<string, EpicViewTab | undefined>> {
  if (ids.size === 0) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => !ids.has(id)),
  );
}

/** Drop `ids` from the parallel `canvasByTabId` map (permanent tab deletes). */
function withoutCanvasByTabIds(
  record: Readonly<Record<string, EpicCanvasState | undefined>>,
  ids: ReadonlySet<string>,
): Readonly<Record<string, EpicCanvasState | undefined>> {
  if (ids.size === 0) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => !ids.has(id)),
  );
}

/** Drop `ids` from `closedTilePayloadsByTabId` (permanent tab deletes). */
function withoutClosedTilePayloadsByTabIds(
  record: EpicCanvasStore["closedTilePayloadsByTabId"],
  ids: ReadonlySet<string>,
): EpicCanvasStore["closedTilePayloadsByTabId"] {
  if (ids.size === 0) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => !ids.has(id)),
  );
}

/**
 * Per-tab cap on preserved closed-tile payloads. Bounds
 * `closedTilePayloadsByTabId` memory growth across a long session of
 * open/close churn; a payload evicted before its history entry is just a
 * cache miss - the preview-reopen lookup falls back to the existing
 * stale-route restore.
 */
const MAX_CLOSED_TILE_PAYLOADS_PER_TAB = 20;

/** Adds `ref` to a tab's closed-tile payload map, FIFO-evicting the oldest
 * entry once the per-tab cap is exceeded. */
function withClosedTilePayload(
  forTab: Readonly<Record<string, ClosedTilePayload | undefined>>,
  ref: EpicCanvasTileRef,
  pendingCreate: boolean,
): Readonly<Record<string, ClosedTilePayload | undefined>> {
  const withoutDuplicate = Object.entries(forTab).filter(
    ([instanceId]) => instanceId !== ref.instanceId,
  );
  const entries = [
    ...withoutDuplicate,
    [ref.instanceId, { node: ref, pendingCreate }] as const,
  ];
  const bounded =
    entries.length > MAX_CLOSED_TILE_PAYLOADS_PER_TAB
      ? entries.slice(entries.length - MAX_CLOSED_TILE_PAYLOADS_PER_TAB)
      : entries;
  return Object.fromEntries(bounded);
}

/** Drops a single `instanceId` entry from a tab's closed-tile payload map -
 * used once `restoreClosedTilePreview` brings it back to life. */
function withoutClosedTilePayload(
  forTab: Readonly<Record<string, ClosedTilePayload | undefined>>,
  instanceId: string,
): Readonly<Record<string, ClosedTilePayload | undefined>> {
  return Object.fromEntries(
    Object.entries(forTab).filter(([id]) => id !== instanceId),
  );
}

/**
 * Diffs a tab's `tilesByInstanceId` before/after a canvas update and folds
 * every removed tile's payload into `closedTilePayloadsByTabId`, so a later
 * back/forward navigation can reopen it as a preview
 * (`openTilePreviewInTab`). Returns the SAME map reference when nothing was
 * removed, matching the no-op-skips-the-write convention `updateTabCanvas`
 * relies on.
 */
function captureClosedTilePayloads(
  state: EpicCanvasStore,
  tabId: string,
  before: TilesByInstanceId,
  after: TilesByInstanceId,
): EpicCanvasStore["closedTilePayloadsByTabId"] {
  const removed = Object.entries(before).flatMap(([instanceId, ref]) =>
    ref !== undefined && after[instanceId] === undefined ? [ref] : [],
  );
  if (removed.length === 0) return state.closedTilePayloadsByTabId;
  const nextForTab = removed.reduce(
    (forTab, ref) =>
      withClosedTilePayload(
        forTab,
        ref,
        state.pendingCreateArtifactIds.has(ref.id),
      ),
    state.closedTilePayloadsByTabId[tabId] ?? {},
  );
  return { ...state.closedTilePayloadsByTabId, [tabId]: nextForTab };
}

function clearClosedTilePendingCreate(
  closedTilePayloadsByTabId: EpicCanvasStore["closedTilePayloadsByTabId"],
  artifactId: string,
): EpicCanvasStore["closedTilePayloadsByTabId"] {
  const entries = Object.entries(closedTilePayloadsByTabId).map(
    ([tabId, forTab]) => {
      if (forTab === undefined) {
        return { entry: [tabId, forTab] as const, changed: false };
      }
      const payloads = Object.entries(forTab).map(([instanceId, payload]) => {
        if (
          payload === undefined ||
          !payload.pendingCreate ||
          payload.node.id !== artifactId
        ) {
          return {
            entry: [instanceId, payload] as const,
            changed: false,
          };
        }
        return {
          entry: [instanceId, { ...payload, pendingCreate: false }] as const,
          changed: true,
        };
      });
      const changed = payloads.some((payload) => payload.changed);
      const nextForTab = changed
        ? Object.fromEntries(payloads.map((payload) => payload.entry))
        : forTab;
      return { entry: [tabId, nextForTab] as const, changed };
    },
  );
  return entries.some((entry) => entry.changed)
    ? Object.fromEntries(entries.map((entry) => entry.entry))
    : closedTilePayloadsByTabId;
}

function withoutRecentTabIds(
  record: Readonly<Record<string, string | undefined>>,
  removedTabIds: ReadonlySet<string>,
): Readonly<Record<string, string | undefined>> {
  if (removedTabIds.size === 0) return record;
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry) => entry[1] === undefined || !removedTabIds.has(entry[1]),
    ),
  );
}

function nextOpenTabAfterClose(
  openTabOrder: ReadonlyArray<string>,
  closingTabId: string,
): string | null {
  const index = openTabOrder.indexOf(closingTabId);
  if (index === -1) return openTabOrder.at(-1) ?? null;
  const remaining = openTabOrder.filter((id) => id !== closingTabId);
  if (remaining.length === 0) return null;
  const targetIndex = index > 0 ? index - 1 : 0;
  return remaining[Math.min(targetIndex, remaining.length - 1)] ?? null;
}

function nextOpenTabAfterBulkClose(
  openTabOrder: ReadonlyArray<string>,
  activeTabId: string | null,
  closingTabIds: ReadonlySet<string>,
): string | null {
  if (activeTabId === null || !closingTabIds.has(activeTabId)) {
    return activeTabId;
  }
  const index = openTabOrder.indexOf(activeTabId);
  const remaining = openTabOrder.filter((id) => !closingTabIds.has(id));
  if (remaining.length === 0) return null;
  if (index === -1) return remaining.at(-1) ?? null;
  const targetIndex = index > 0 ? index - 1 : 0;
  return remaining[Math.min(targetIndex, remaining.length - 1)] ?? null;
}

function stripCopySuffix(name: string): string {
  return name.replace(/ \(copy(?: \d+)?\)$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nextCopyName(
  sourceName: string,
  siblingNames: ReadonlyArray<string>,
): string {
  const base = stripCopySuffix(sourceName);
  const seen = new Set(siblingNames);
  const first = `${base} (copy)`;
  if (!seen.has(first)) return first;
  const copyRe = new RegExp(`^${escapeRegExp(base)} \\(copy (\\d+)\\)$`);
  const max = siblingNames.reduce((acc, name) => {
    if (name === first) return Math.max(acc, 1);
    const match = copyRe.exec(name);
    if (match === null) return acc;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? Math.max(acc, parsed) : acc;
  }, 1);
  return `${base} (copy ${max + 1})`;
}

function moveId(
  items: ReadonlyArray<string>,
  id: string,
  targetIndex: number,
): ReadonlyArray<string> {
  const fromIndex = items.indexOf(id);
  if (fromIndex === -1) return items;
  const clampedIndex = Math.max(0, Math.min(targetIndex, items.length));
  const insertIndex =
    fromIndex < clampedIndex ? clampedIndex - 1 : clampedIndex;
  if (fromIndex === insertIndex) return items;
  const withoutItem = [
    ...items.slice(0, fromIndex),
    ...items.slice(fromIndex + 1),
  ];
  return [
    ...withoutItem.slice(0, insertIndex),
    id,
    ...withoutItem.slice(insertIndex),
  ];
}

function updateTabCanvas(
  state: EpicCanvasStore,
  tabId: string,
  updater: (canvas: EpicCanvasState) => EpicCanvasState,
): Partial<EpicCanvasStore> {
  // No-ops return `state` itself: zustand's set() short-circuits on
  // Object.is, so listeners (selectors, the desktop projection subscriber)
  // never fire. Returning `{}` would still create a fresh state object.
  if (state.tabsById[tabId] === undefined) return state;
  const current = state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
  const next = updater(current);
  if (next === current) return state;
  return {
    canvasByTabId: {
      ...state.canvasByTabId,
      [tabId]: next,
    },
    closedTilePayloadsByTabId: captureClosedTilePayloads(
      state,
      tabId,
      current.tilesByInstanceId,
      next.tilesByInstanceId,
    ),
  };
}

function canvasForExistingTab(
  state: EpicCanvasStore,
  tabId: string,
): EpicCanvasState | null {
  if (state.tabsById[tabId] === undefined) return null;
  return state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
}

function currentNestedFocusTargetForTab(
  state: EpicCanvasStore,
  tabId: string,
): NestedFocusTarget | null {
  const canvas = canvasForExistingTab(state, tabId);
  return canvas === null ? null : getCurrentNestedFocusTarget(canvas);
}

function exactNestedFocusTargetForTab(
  state: EpicCanvasStore,
  tabId: string,
  target: NestedFocusTarget,
): NestedFocusTarget | null {
  const canvas = canvasForExistingTab(state, tabId);
  return canvas === null ? null : resolveNestedFocusTarget(canvas, target);
}

function changedNestedFocusTarget(
  before: NestedFocusTarget | null,
  after: NestedFocusTarget | null,
): NestedFocusTarget | null {
  return areNestedFocusTargetsEqual(before, after) ? null : after;
}

function changedCanvasFocusTarget(
  before: EpicCanvasState | null,
  after: EpicCanvasState | null,
): NestedFocusTarget | null {
  if (before === null || after === null || before === after) return null;
  return getCurrentNestedFocusTarget(after);
}

interface AppendArtifactRecordArgs {
  readonly state: EpicCanvasStore;
  readonly epicId: string;
  readonly parentId: string | null;
  readonly type: EpicNodeKind;
  readonly hostId: string;
}

function appendArtifactRecord(args: AppendArtifactRecordArgs): {
  patch: Partial<EpicCanvasStore>;
  id: string;
  node: EpicCanvasTileRef | null;
} | null {
  const { state, epicId, parentId, type, hostId } = args;
  const records = state.artifactTreeByEpicId[epicId] ?? [];
  if (parentId !== null && !records.some((r) => r.id === parentId)) {
    return null;
  }
  const id = uuidv4();
  const name = DEFAULT_EPIC_NODE_NAMES[type];
  const newRecord: EpicNodeRecord = { id, parentId, name, type, hostId };
  const patch = {
    artifactTreeByEpicId: {
      ...state.artifactTreeByEpicId,
      [epicId]: [...records, newRecord],
    },
  };
  return {
    patch,
    id,
    node: isOpenableEpicNodeKind(type)
      ? makeOpenableNodeRef({ id, instanceId: uuidv4(), type, name, hostId })
      : null,
  };
}

/**
 * Options for `guardCanvasMutation`. This guard is always strict: the sole
 * sanctioned epicId resolution (`resolveTabEpicIdentity`) does not call it at
 * all - it commits through the module-private raw setter directly, so
 * provenance is enforced by module privacy rather than a parameter every
 * ingress has to thread and every caller of this function has to reason
 * about.
 */
interface CanvasMutationGuardOptions {
  readonly ingressContext: string;
  readonly throwOnViolation: boolean;
}

/**
 * Shared identity guard for every canvas-mutation ingress: the closure-local
 * `set` below (which delegates to the guarded public `setState` wrapper) and
 * persisted hydration. `epicId` lives on `tabsById`, not `canvasByTabId`, so
 * a candidate must be checked whenever EITHER map changes - a
 * `tabsById`-only patch can repoint every tile in a tab without ever
 * touching `canvasByTabId`.
 */
function guardCanvasMutation(
  state: EpicCanvasStore,
  resolved: Partial<EpicCanvasStore>,
  options: CanvasMutationGuardOptions,
): boolean {
  const { ingressContext, throwOnViolation } = options;
  const nextCanvasByTabId = resolved.canvasByTabId ?? state.canvasByTabId;
  const nextTabsById = resolved.tabsById ?? state.tabsById;
  if (
    nextCanvasByTabId === state.canvasByTabId &&
    nextTabsById === state.tabsById
  ) {
    return true;
  }
  return enforceTileIdentityInvariant(
    collectTileIdentityRegistry(
      state.canvasByTabId,
      (tabId) => state.tabsById[tabId]?.epicId ?? null,
    ),
    {
      canvasByTabId: nextCanvasByTabId,
      epicIdForTabId: (tabId) => nextTabsById[tabId]?.epicId ?? null,
      ingressContext,
    },
    throwOnViolation,
  );
}

export const useEpicCanvasStore = create<EpicCanvasStore>()(
  persist(
    (_rawSet, get) => {
      // Single choke point for every internal canvas mutation (all ~60 call
      // sites below funnel through this closure's `set`, including the ones
      // that write `canvasByTabId` directly rather than via `updateTabCanvas`
      // - e.g. `tearOffTabIntoNewHeaderTab`, `duplicateTab`). Delegates to
      // the guarded public `setState` wrapper (defined after this store is
      // created) rather than duplicating its guard logic - persisted
      // hydration is the only other ingress point, since it runs through the
      // `merge` option below instead of this closure.
      const set = (
        partial:
          | Partial<EpicCanvasStore>
          | ((state: EpicCanvasStore) => Partial<EpicCanvasStore>),
      ): void => {
        useEpicCanvasStore.setState(partial, undefined);
      };
      return {
        tabsById: {},
        canvasByTabId: {},
        closedTilePayloadsByTabId: {},
        openTabOrder: [],
        activeTabId: null,
        mostRecentTabIdByEpicId: {},
        artifactTreeByEpicId: EMPTY_TREES,
        selfDeletedArtifactIds: new Set<string>(),
        pendingCreateArtifactIds: new Set<string>(),
        preAckRootCreatesByEpic: {},
        pendingRootCreatesByEpic: {},
        pendingEpicTitles: {},
        pendingChatTitles: {},

        openEpicTab: (epicId, name) => {
          const tab = createEpicViewTab(epicId, name);
          set((state) => ({
            ...appendedEpicTabState(state, tab),
            activeTabId: tab.tabId,
          }));
          return tab.tabId;
        },

        openEpicTabWithId: (tabId, epicId, name) => {
          // `closeTab` preserves the record in `tabsById` so the tab can be
          // reopened, which means an existing record is NOT the same thing as an
          // open tab. Returning the id without revealing it hands the caller a
          // ref that `tabSourceRefs()` does not back, and strip reconciliation
          // then deletes the layout item the caller just placed. `setActiveTab`
          // re-pushes onto `openTabOrder` and no-ops when already open + active.
          if (get().tabsById[tabId] !== undefined) {
            get().setActiveTab(tabId);
            return tabId;
          }
          const tab: EpicViewTab = {
            tabId,
            epicId,
            name: name ?? UNTITLED_EPIC_TITLE,
          };
          set((state) => ({
            ...appendedEpicTabState(state, tab),
            activeTabId: tab.tabId,
          }));
          return tab.tabId;
        },

        openPhaseMigrationTabWithId: (tabId, phaseId, name) => {
          const existingId = resolveTabIdForPhaseMigration(get(), phaseId);
          if (existingId !== null) {
            get().setActiveTab(existingId);
            return existingId;
          }
          const existing = get().tabsById[tabId];
          if (existing !== undefined) return existing.tabId;
          const tab: EpicViewTab = {
            tabId,
            epicId: phaseId,
            name: name ?? UNTITLED_EPIC_TITLE,
            surfaceMode: { kind: "phase-migration", phaseId },
          };
          set((state) => ({
            ...appendedEpicTabState(state, tab),
            activeTabId: tab.tabId,
          }));
          return tab.tabId;
        },

        openEpicTabInBackground: (epicId, name) => {
          const existing = resolveTabIdForEpic(get(), epicId);
          if (existing !== null) {
            // Reveal a preserved-but-hidden tab in the strip without activating
            // it; an already-visible tab is left exactly where it is. The
            // functional updater is the single guard - it no-ops (returns the
            // same state, which Zustand bails on) when the tab is already shown.
            set((current) =>
              current.openTabOrder.includes(existing)
                ? current
                : { openTabOrder: [...current.openTabOrder, existing] },
            );
            return existing;
          }
          const tab = createEpicViewTab(epicId, name);
          // activeTabId is intentionally left untouched - the tab opens behind
          // the current surface and never steals focus.
          set((current) => appendedEpicTabState(current, tab));
          return tab.tabId;
        },

        closeTab: (tabId) => {
          if (isTabCloseLocked({ kind: "epic", id: tabId })) return;
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined) return state;
            const openTabOrder = state.openTabOrder.filter(
              (id) => id !== tabId,
            );
            const activeTabId =
              state.activeTabId === tabId
                ? nextOpenTabAfterClose(state.openTabOrder, tabId)
                : state.activeTabId;
            // The tab record stays untouched in `tabsById` (preserved for reopen);
            // hiding only updates order/active/recent pointers.
            return {
              openTabOrder,
              activeTabId,
              mostRecentTabIdByEpicId: {
                ...state.mostRecentTabIdByEpicId,
                [tab.epicId]: tabId,
              },
            };
          });
        },

        closeTabsForEpics: (epicIds) => {
          const targetEpicIds = new Set(epicIds);
          if (targetEpicIds.size === 0) return;
          // Cancel any in-flight epic-title backstop timers so a deletion
          // can't strand a 30s no-op timer in the map.
          for (const epicId of targetEpicIds) {
            clearScheduledTitlePending(epicTitleTimers, epicId);
          }
          set((state) => {
            const removedTabIds = new Set(
              Object.keys(state.tabsById).filter((tabId) => {
                const tab = state.tabsById[tabId];
                return tab !== undefined && targetEpicIds.has(tab.epicId);
              }),
            );
            if (removedTabIds.size === 0) return state;
            const openTabOrder = state.openTabOrder.filter(
              (tabId) => !removedTabIds.has(tabId),
            );
            return {
              tabsById: withoutTabIds(state.tabsById, removedTabIds),
              canvasByTabId: withoutCanvasByTabIds(
                state.canvasByTabId,
                removedTabIds,
              ),
              closedTilePayloadsByTabId: withoutClosedTilePayloadsByTabIds(
                state.closedTilePayloadsByTabId,
                removedTabIds,
              ),
              openTabOrder,
              activeTabId: nextOpenTabAfterBulkClose(
                state.openTabOrder,
                state.activeTabId,
                removedTabIds,
              ),
              mostRecentTabIdByEpicId: withoutRecentTabIds(
                state.mostRecentTabIdByEpicId,
                removedTabIds,
              ),
              artifactTreeByEpicId: Object.fromEntries(
                Object.entries(state.artifactTreeByEpicId).filter(
                  ([epicId]) => !targetEpicIds.has(epicId),
                ),
              ),
              preAckRootCreatesByEpic: Object.fromEntries(
                Object.entries(state.preAckRootCreatesByEpic).filter(
                  ([epicId]) => !targetEpicIds.has(epicId),
                ),
              ),
              pendingRootCreatesByEpic: Object.fromEntries(
                Object.entries(state.pendingRootCreatesByEpic).filter(
                  ([epicId]) => !targetEpicIds.has(epicId),
                ),
              ),
              pendingEpicTitles: Object.fromEntries(
                Object.entries(state.pendingEpicTitles).filter(
                  ([epicId]) => !targetEpicIds.has(epicId),
                ),
              ),
            };
          });
        },

        closeOtherTabs: (tabId) => {
          set((state) => {
            const keep = state.tabsById[tabId];
            if (keep === undefined) return state;
            // Hidden tabs stay in `tabsById` untouched (preserved for reopen);
            // only order/active/recent change.
            return {
              openTabOrder: [tabId],
              activeTabId: tabId,
              mostRecentTabIdByEpicId: {
                ...state.mostRecentTabIdByEpicId,
                [keep.epicId]: tabId,
              },
            };
          });
        },

        moveOpenTab: (tabId, targetIndex) => {
          if (isTabStructurallyLocked({ kind: "epic", id: tabId })) return;
          set((state) => {
            const next = moveId(state.openTabOrder, tabId, targetIndex);
            return next === state.openTabOrder ? state : { openTabOrder: next };
          });
        },

        duplicateTab: (tabId) => {
          if (isTabStructurallyLocked({ kind: "epic", id: tabId })) {
            return null;
          }
          const state = get();
          const source = state.tabsById[tabId];
          if (source === undefined) return null;
          if (source.surfaceMode?.kind === "phase-migration") return null;
          const newId = uuidv4();
          const siblingNames = epicTabNames(state.tabsById, source.epicId);
          const sourceCanvas =
            state.canvasByTabId[tabId] ?? createEmptyCanvas();
          const newTab: EpicViewTab = {
            tabId: newId,
            epicId: source.epicId,
            name: nextCopyName(source.name, siblingNames),
          };
          set((current) => {
            const insertAt = current.openTabOrder.indexOf(tabId) + 1;
            return {
              tabsById: { ...current.tabsById, [newId]: newTab },
              canvasByTabId: {
                ...current.canvasByTabId,
                [newId]: cloneEpicCanvasState(sourceCanvas),
              },
              openTabOrder: [
                ...current.openTabOrder.slice(0, insertAt),
                newId,
                ...current.openTabOrder.slice(insertAt),
              ],
              activeTabId: newId,
              mostRecentTabIdByEpicId: {
                ...current.mostRecentTabIdByEpicId,
                [newTab.epicId]: newId,
              },
            };
          });
          return newId;
        },

        openTileInNewTab: (epicId, node, insertIndex) => {
          const state = get();
          const sourceTabId = resolveTabIdForEpic(state, epicId);
          const sourceTab =
            sourceTabId === null ? null : (state.tabsById[sourceTabId] ?? null);
          const tabId = uuidv4();
          const siblingNames = epicTabNames(state.tabsById, epicId);
          const tabName =
            sourceTab === null
              ? node.name
              : nextCopyName(sourceTab.name, siblingNames);
          const tab: EpicViewTab = {
            tabId,
            epicId,
            name: tabName,
          };
          set((current) => {
            const insertAt =
              insertIndex === null
                ? current.openTabOrder.length
                : Math.max(
                    0,
                    Math.min(insertIndex, current.openTabOrder.length),
                  );
            return {
              tabsById: { ...current.tabsById, [tabId]: tab },
              canvasByTabId: {
                ...current.canvasByTabId,
                [tabId]: createSingleTileCanvas(node),
              },
              openTabOrder: [
                ...current.openTabOrder.slice(0, insertAt),
                tabId,
                ...current.openTabOrder.slice(insertAt),
              ],
              activeTabId: tabId,
              mostRecentTabIdByEpicId: {
                ...current.mostRecentTabIdByEpicId,
                [epicId]: tabId,
              },
            };
          });
          const analyticsTarget = analyticsTargetForCanvasTileType(node.type);
          if (analyticsTarget !== null) {
            Analytics.getInstance().track(AnalyticsEvent.TabCreated, {
              target: analyticsTarget,
            });
          }
          return tabId;
        },

        tearOffTabIntoNewHeaderTab: (args) => {
          const state = get();
          const sourceTab = state.tabsById[args.sourceTabId];
          if (sourceTab === undefined) return null;
          const sourceCanvas =
            state.canvasByTabId[args.sourceTabId] ?? EMPTY_CANVAS;
          const pane = findPaneById(sourceCanvas.root, args.sourcePaneId);
          const node =
            pane !== null && pane.tabInstanceIds.includes(args.sourceTileTabId)
              ? (sourceCanvas.tilesByInstanceId[args.sourceTileTabId] ?? null)
              : null;
          if (pane === null || node === null) return null;
          // Ticket 20: the torn-off tile always remounts - it moves from the
          // source header tab's canvas root into a brand-new header tab's
          // canvas root, a completely different React parent chain (MOVE
          // semantics, same instanceId - see the corrected comment at
          // `commitHeaderStripDrop`'s call site). When it was its source
          // pane's only tab, `closeTileTab` below falls through to
          // `closePane`, which can also dissolve that pane's parent group and
          // remount a sibling. Flush both before `set()` commits the move.
          flushChatTabViewportHandoff([
            args.sourceTileTabId,
            ...(pane.tabInstanceIds.length === 1
              ? paneRemovalDissolveHandoffTargets(
                  sourceCanvas.root,
                  args.sourcePaneId,
                )
              : []),
          ]);
          const newId = uuidv4();
          const siblingNames = epicTabNames(state.tabsById, sourceTab.epicId);
          const newTab: EpicViewTab = {
            tabId: newId,
            epicId: sourceTab.epicId,
            name: nextCopyName(sourceTab.name, siblingNames),
          };
          set((current) => {
            const currentSource = current.tabsById[args.sourceTabId];
            if (currentSource === undefined) return current;
            const currentSourceCanvas =
              current.canvasByTabId[args.sourceTabId] ?? EMPTY_CANVAS;
            const insertAt = Math.max(
              0,
              Math.min(args.insertIndex, current.openTabOrder.length),
            );
            return {
              tabsById: {
                ...current.tabsById,
                [newId]: newTab,
              },
              canvasByTabId: {
                ...current.canvasByTabId,
                [args.sourceTabId]: closeTileTab(
                  currentSourceCanvas,
                  args.sourcePaneId,
                  args.sourceTileTabId,
                ),
                [newId]: createSingleTileCanvas(node),
              },
              openTabOrder: [
                ...current.openTabOrder.slice(0, insertAt),
                newId,
                ...current.openTabOrder.slice(insertAt),
              ],
              activeTabId: newId,
              mostRecentTabIdByEpicId: {
                ...current.mostRecentTabIdByEpicId,
                [newTab.epicId]: newId,
              },
            };
          });
          const analyticsTarget = analyticsTargetForCanvasTileType(node.type);
          if (analyticsTarget !== null) {
            Analytics.getInstance().track(AnalyticsEvent.TabMoved, {
              target: analyticsTarget,
            });
          }
          return newId;
        },

        setActiveTab: (tabId) => {
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined) return state;
            const isOpen = state.openTabOrder.includes(tabId);
            if (state.activeTabId === tabId && isOpen) return state;
            // Activation only moves order/active/recent pointers; the tab record
            // stays stable so header-strip / command-palette consumers (which read
            // tab metadata) don't re-render on every tab switch.
            return {
              openTabOrder: isOpen
                ? state.openTabOrder
                : [...state.openTabOrder, tabId],
              activeTabId: tabId,
              mostRecentTabIdByEpicId: {
                ...state.mostRecentTabIdByEpicId,
                [tab.epicId]: tabId,
              },
            };
          });
        },

        renameTab: (tabId, name) => {
          const trimmed = name.trim();
          if (trimmed.length === 0) return;
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined || tab.name === trimmed) return state;
            return {
              tabsById: {
                ...state.tabsById,
                [tabId]: { ...tab, name: trimmed },
              },
            };
          });
        },

        discardTabState: (tabId) => {
          if (isTabStructurallyLocked({ kind: "epic", id: tabId })) {
            return null;
          }
          const tab = get().tabsById[tabId];
          if (tab === undefined) return null;
          set((state) => {
            const removed = new Set([tabId]);
            return {
              tabsById: withoutTabIds(state.tabsById, removed),
              canvasByTabId: withoutCanvasByTabIds(
                state.canvasByTabId,
                removed,
              ),
              closedTilePayloadsByTabId: withoutClosedTilePayloadsByTabIds(
                state.closedTilePayloadsByTabId,
                removed,
              ),
              openTabOrder: state.openTabOrder.filter((id) => id !== tabId),
              activeTabId:
                state.activeTabId === tabId
                  ? nextOpenTabAfterClose(state.openTabOrder, tabId)
                  : state.activeTabId,
              mostRecentTabIdByEpicId: withoutRecentTabIds(
                state.mostRecentTabIdByEpicId,
                removed,
              ),
            };
          });
          return {
            epicTabs: projectTabsForDesktop(get()),
            activeTabId: get().activeTabId,
            canvasByTabId: { [tabId]: null },
          };
        },

        resolveTargetTabForEpic: (epicId, name) => {
          const state = get();
          const existing = resolveTabIdForEpic(state, epicId);
          if (existing !== null) {
            if (!state.openTabOrder.includes(existing)) {
              state.setActiveTab(existing);
            }
            return existing;
          }
          // Caller-supplied name comes from the row the user clicked on
          // (history list, command palette, deep link). Falls back to
          // "Untitled task" only when the caller has no title in hand.
          return state.openEpicTab(epicId, name ?? UNTITLED_EPIC_TITLE);
        },

        resolveTabIdForEpic: (epicId) => resolveTabIdForEpic(get(), epicId),

        openTileInTab: (tabId, node) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openTile(canvas, node, false, null),
            ),
          );
        },

        prepareOpenTileInTabFocusTarget: (tabId, node) => {
          get().openTileInTab(tabId, node);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          return after;
        },

        prepareOpenTileInTabFocusTargetFromSource: (tabId, node, source) => {
          const before = canvasForExistingTab(get(), tabId);
          get().openTileInTab(tabId, node);
          const canvas = canvasForExistingTab(get(), tabId);
          if (before !== canvas) trackOpenedCanvasTile(node, source);
          return currentNestedFocusTargetForTab(get(), tabId);
        },

        openTilePreviewInTab: (tabId, node) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openTile(canvas, node, true, null),
            ),
          );
        },

        prepareOpenTilePreviewInTabFocusTarget: (tabId, node) => {
          get().openTilePreviewInTab(tabId, node);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          return after;
        },

        prepareOpenTilePreviewInTabFocusTargetFromSource: (
          tabId,
          node,
          source,
        ) => {
          const before = canvasForExistingTab(get(), tabId);
          get().openTilePreviewInTab(tabId, node);
          const canvas = canvasForExistingTab(get(), tabId);
          if (before !== canvas) trackOpenedCanvasTile(node, source);
          return currentNestedFocusTargetForTab(get(), tabId);
        },

        restoreClosedTilePreview: (tabId, preferredPaneId, node) => {
          set((state) => {
            const forTab = state.closedTilePayloadsByTabId[tabId];
            const restoredPayload = forTab?.[node.instanceId];
            const withoutRestored =
              forTab === undefined || restoredPayload === undefined
                ? state.closedTilePayloadsByTabId
                : {
                    ...state.closedTilePayloadsByTabId,
                    [tabId]: withoutClosedTilePayload(forTab, node.instanceId),
                  };
            const pendingCreateArtifactIds = restoredPayload?.pendingCreate
              ? withId(state.pendingCreateArtifactIds, node.id)
              : state.pendingCreateArtifactIds;
            // Strip the entry being restored BEFORE the canvas update runs its
            // own eviction-capture: capturing against a map that still counts
            // the restored entry can push a same-transaction preview eviction
            // (e.g. the destination pane's prior preview) past the per-tab FIFO
            // cap and needlessly evict an unrelated payload.
            const baseState = {
              ...state,
              closedTilePayloadsByTabId: withoutRestored,
              pendingCreateArtifactIds,
            };
            const canvasUpdate = updateTabCanvas(baseState, tabId, (canvas) =>
              restoreTilePreviewCanvas(canvas, node, preferredPaneId),
            );
            if (canvasUpdate === baseState) {
              return withoutRestored === state.closedTilePayloadsByTabId
                ? state
                : { closedTilePayloadsByTabId: withoutRestored };
            }
            return pendingCreateArtifactIds === state.pendingCreateArtifactIds
              ? canvasUpdate
              : { ...canvasUpdate, pendingCreateArtifactIds };
          });
        },

        discardClosedTilePayload: (tabId, instanceId) => {
          set((state) => {
            const forTab = state.closedTilePayloadsByTabId[tabId];
            if (forTab === undefined || forTab[instanceId] === undefined) {
              return state;
            }
            return {
              closedTilePayloadsByTabId: {
                ...state.closedTilePayloadsByTabId,
                [tabId]: withoutClosedTilePayload(forTab, instanceId),
              },
            };
          });
        },

        openTileInBackgroundTab: (tabId, node) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openTileInBackgroundTabCanvas(canvas, node),
            ),
          );
        },

        prepareOpenTileInBackgroundTabFocusTarget: (tabId, node) => {
          get().openTileInBackgroundTab(tabId, node);
          return null;
        },

        prepareOpenTileInBackgroundTabFocusTargetFromSource: (
          tabId,
          node,
          source,
        ) => {
          const before = canvasForExistingTab(get(), tabId);
          get().openTileInBackgroundTab(tabId, node);
          const after = canvasForExistingTab(get(), tabId);
          if (before !== after) trackOpenedCanvasTile(node, source);
          return null;
        },

        openTileInPane: (tabId, paneId, ref) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openTileInPaneCanvas(canvas, paneId, ref),
            ),
          );
        },

        prepareOpenTileInPaneFocusTarget: (tabId, paneId, ref) => {
          const before = canvasForExistingTab(get(), tabId);
          const targetPane =
            before === null ? null : findPaneById(before.root, paneId);
          get().openTileInPane(tabId, paneId, ref);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = targetPane === null ? null : after;
          return target;
        },

        prepareOpenSingletonTileInPaneFocusTarget: (tabId, paneId, ref) => {
          const before = canvasForExistingTab(get(), tabId);
          const targetPane =
            before === null ? null : findPaneById(before.root, paneId);
          const existingSingleton =
            before === null ? null : findPaneTabByContentId(before, ref.id);
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openSingletonTileInPaneCanvas(canvas, paneId, ref),
            ),
          );
          const after = currentNestedFocusTargetForTab(get(), tabId);
          // A focus of an ALREADY-OPEN singleton is still a real focus target
          // even when the requested pane is stale - the canvas focused the
          // existing instance in ITS pane regardless. Null only when nothing
          // could have happened: no pane to insert into AND no existing
          // instance to focus.
          return targetPane === null && existingSingleton === null
            ? null
            : after;
        },

        prepareOpenTileInPaneFocusTargetFromSource: (
          tabId,
          paneId,
          ref,
          source,
        ) => {
          const before = canvasForExistingTab(get(), tabId);
          const targetPane =
            before === null ? null : findPaneById(before.root, paneId);
          get().openTileInPane(tabId, paneId, ref);
          const canvas = canvasForExistingTab(get(), tabId);
          if (before !== canvas) trackOpenedCanvasTile(ref, source);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = targetPane === null ? null : after;
          return target;
        },

        openBlankTabInPane: (tabId, paneId) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              openBlankTabInPaneCanvas(canvas, paneId),
            ),
          );
        },

        prepareOpenBlankTabInPaneFocusTarget: (tabId, paneId) => {
          const before = canvasForExistingTab(get(), tabId);
          const targetPane =
            before === null ? null : findPaneById(before.root, paneId);
          get().openBlankTabInPane(tabId, paneId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = targetPane === null ? null : after;
          return target;
        },

        updateGitDiffTileViewInTab: (tabId, tileId, view) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              updateGitDiffTileView(canvas, tileId, view),
            ),
          );
        },

        updateSnapshotDiffTileViewInTab: (tabId, tileId, view) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              updateSnapshotDiffTileView(canvas, tileId, view),
            ),
          );
        },

        updateCommGraphTileViewInTab: (tabId, tileId, view) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              updateCommGraphTileView(canvas, tileId, view),
            ),
          );
        },

        updatePrDiffTileViewInTab: (tabId, tileId, view) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              updatePrDiffTileView(canvas, tileId, view),
            ),
          );
        },

        togglePrDiffFileCollapsedInTab: (tabId, tileId, filePath) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              togglePrDiffFileCollapsed(canvas, tileId, filePath),
            ),
          );
        },

        toggleGitDiffBundleFileCollapsedInTab: (tabId, tileId, filePath) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              toggleGitDiffBundleFileCollapsed(canvas, tileId, filePath),
            ),
          );
        },

        toggleSnapshotDiffBundleFileCollapsedInTab: (
          tabId,
          tileId,
          filePath,
        ) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              toggleSnapshotDiffBundleFileCollapsed(canvas, tileId, filePath),
            ),
          );
        },

        promotePreviewInTab: (tabId, paneId) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              promotePreview(canvas, paneId),
            ),
          );
        },

        applyNestedRouteFocus: (tabId, target) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              target.tileInstanceId === undefined
                ? setActivePane(canvas, target.paneId)
                : setActiveTileTabCanvas(
                    canvas,
                    target.paneId,
                    target.tileInstanceId,
                  ),
            ),
          );
        },

        setActiveTileTab: (tabId, paneId, tileTabId) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              setActiveTileTabCanvas(canvas, paneId, tileTabId),
            ),
          );
        },

        prepareSetActiveTileTabFocusTarget: (tabId, paneId, tileTabId) => {
          get().setActiveTileTab(tabId, paneId, tileTabId);
          const target = exactNestedFocusTargetForTab(get(), tabId, {
            paneId,
            tileInstanceId: tileTabId,
          });
          return target;
        },

        setActiveTilePane: (tabId, paneId) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              setActivePane(canvas, paneId),
            ),
          );
        },

        prepareSetActiveTilePaneFocusTarget: (tabId, paneId) => {
          get().setActiveTilePane(tabId, paneId);
          const target = currentNestedFocusTargetForTab(get(), tabId);
          const returned = target?.paneId === paneId ? target : null;
          return returned;
        },

        insertNodeOnTabStrip: (tabId, targetPaneId, targetIndex, node) => {
          // Ticket 20: mirrors `dropOnTabStrip`'s own node-kind resolution -
          // dropping a node already open in a DIFFERENT pane routes through
          // `moveTabAcrossPanes` there, remounting that pane's painted tile
          // exactly like an explicit cross-pane drag (and, if it empties its
          // source pane, can also dissolve a sibling's parent group). Flush
          // both before `set()` commits the move.
          const before = canvasForExistingTab(get(), tabId);
          if (before !== null) {
            const existing = findPaneTabByContentId(before, node.id);
            if (existing !== null && existing.pane.id !== targetPaneId) {
              flushChatTabViewportHandoff([
                existing.instanceId,
                ...(existing.pane.tabInstanceIds.length === 1
                  ? paneRemovalDissolveHandoffTargets(
                      before.root,
                      existing.pane.id,
                    )
                  : []),
              ]);
            }
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              dropOnTabStrip(
                canvas,
                { kind: "node", node },
                targetPaneId,
                targetIndex,
              ),
            ),
          );
        },

        prepareInsertNodeOnTabStripFocusTarget: (
          tabId,
          targetPaneId,
          targetIndex,
          node,
        ) => {
          const before = canvasForExistingTab(get(), tabId);
          const targetPane =
            before === null ? null : findPaneById(before.root, targetPaneId);
          get().insertNodeOnTabStrip(tabId, targetPaneId, targetIndex, node);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = targetPane === null ? null : after;
          return target;
        },

        moveTabOnTabStrip: (tabId, args) => {
          const before = canvasForExistingTab(get(), tabId);
          const node = before?.tilesByInstanceId[args.tabId];
          // Ticket 20: a cross-pane move remounts the dragged tab's painted
          // chat (the keyed layer moves from the source `TabGroupView` to the
          // target one - `moveTabAcrossPanes`). When the dragged tab was its
          // source pane's only tab, that pane also closes and can dissolve its
          // parent group, remounting a SIBLING pane too. Flush both before
          // `set()` commits. A same-pane reorder never remounts anything.
          if (before !== null && args.sourcePaneId !== args.targetPaneId) {
            const sourcePane = findPaneById(before.root, args.sourcePaneId);
            flushChatTabViewportHandoff([
              args.tabId,
              ...(sourcePane !== null && sourcePane.tabInstanceIds.length === 1
                ? paneRemovalDissolveHandoffTargets(
                    before.root,
                    args.sourcePaneId,
                  )
                : []),
            ]);
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) => {
              const sourcePane = findPaneById(canvas.root, args.sourcePaneId);
              const node = canvas.tilesByInstanceId[args.tabId];
              if (sourcePane === null || node === undefined) return canvas;
              return dropOnTabStrip(
                canvas,
                {
                  kind: "tab",
                  sourcePaneId: args.sourcePaneId,
                  tabId: args.tabId,
                  node,
                },
                args.targetPaneId,
                args.targetIndex,
              );
            }),
          );
          const after = canvasForExistingTab(get(), tabId);
          const analyticsTarget =
            node === undefined
              ? null
              : analyticsTargetForCanvasTileType(node.type);
          if (before !== after && analyticsTarget !== null) {
            Analytics.getInstance().track(AnalyticsEvent.TabMoved, {
              target: analyticsTarget,
            });
          }
        },

        prepareMoveActiveTabOnTabStripFocusTarget: (tabId, args) => {
          const beforeCanvas = canvasForExistingTab(get(), tabId);
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().moveTabOnTabStrip(tabId, args);
          const afterCanvas = canvasForExistingTab(get(), tabId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target =
            before?.tileInstanceId !== args.tabId ||
            beforeCanvas === null ||
            afterCanvas === null ||
            beforeCanvas === afterCanvas
              ? null
              : changedNestedFocusTarget(before, after);
          return target;
        },

        splitPaneWithNode: (tabId, targetPaneId, position, node) => {
          const before = canvasForExistingTab(get(), tabId);
          // Ticket 20 (review round 1, finding 1): when the target pane's
          // parent group runs perpendicular to `position` (or the target is
          // the bare root pane), inserting beside it WRAPS the target instead
          // of a flat insertion (`insertPaneAtEdge`) - the target's own
          // painted chat remounts even though this call never touches its
          // content. Flushing its active tab's viewport unconditionally is
          // cheap and correct either way (a flat, non-wrapping insertion
          // leaves it mounted, and the flush is simply harmless there).
          //
          // Separately: `splitPaneAtEdge` (actions.ts) resolves a `node`
          // source whose content is ALREADY OPEN somewhere into a `tab`-kind
          // move BEFORE doing anything else - the same "already open"
          // resolution `insertNodeOnTabStrip`/`dropOnTabStrip` perform, but
          // this call creates a BRAND NEW pane for the moved tab unconditionally
          // (`createPaneWithTab`), regardless of whether the existing tab's
          // source pane is the same as `targetPaneId` - so the moved instance
          // always remounts, not just on a genuine cross-pane move. When its
          // source pane empties (and isn't the target itself - the
          // `splitsIntoItself` case deliberately keeps that pane alive as the
          // split's other half instead of dissolving it), flush the promoted
          // dissolve survivors too.
          if (before !== null) {
            const targetPane = findPaneById(before.root, targetPaneId);
            const targetInstanceId =
              targetPane === null
                ? null
                : resolveActivePaneTab(
                    targetPane.activeTabId,
                    targetPane.tabInstanceIds,
                  );
            const existing = findPaneTabByContentId(before, node.id);
            flushChatTabViewportHandoff([
              ...(targetInstanceId === null ? [] : [targetInstanceId]),
              ...(existing !== null ? [existing.instanceId] : []),
              ...(existing !== null &&
              existing.pane.tabInstanceIds.length === 1 &&
              existing.pane.id !== targetPaneId
                ? paneRemovalDissolveHandoffTargets(
                    before.root,
                    existing.pane.id,
                  )
                : []),
            ]);
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              splitPaneAtEdge(canvas, targetPaneId, position, {
                kind: "node",
                node,
              }),
            ),
          );
          const after = canvasForExistingTab(get(), tabId);
          const analyticsTarget = analyticsTargetForCanvasTileType(node.type);
          if (before !== after && analyticsTarget !== null) {
            Analytics.getInstance().track(AnalyticsEvent.TabSplit, {
              target: analyticsTarget,
            });
          }
        },

        prepareSplitPaneWithNodeFocusTarget: (
          tabId,
          targetPaneId,
          position,
          node,
        ) => {
          const before = canvasForExistingTab(get(), tabId);
          get().splitPaneWithNode(tabId, targetPaneId, position, node);
          const after = canvasForExistingTab(get(), tabId);
          const target = changedCanvasFocusTarget(before, after);
          return target;
        },

        splitPaneWithTab: (tabId, args) => {
          const before = canvasForExistingTab(get(), tabId);
          const node = before?.tilesByInstanceId[args.tabId];
          // Ticket 20: the dragged tab always lands in a brand-new pane
          // (`createPaneWithTab` inside `splitPaneAtEdge`) - it remounts
          // unconditionally, unlike a same-pane/same-axis flat split of a
          // DIFFERENT tab. The target pane can also wrap (see
          // `splitPaneWithNode`'s comment) and, when the drag emptied its
          // source pane, that pane's own close can dissolve a THIRD pane's
          // parent. Flush all three defensively before `set()`.
          if (before !== null) {
            const targetPane = findPaneById(before.root, args.targetPaneId);
            const targetInstanceId =
              targetPane === null
                ? null
                : resolveActivePaneTab(
                    targetPane.activeTabId,
                    targetPane.tabInstanceIds,
                  );
            const sourcePane = findPaneById(before.root, args.sourcePaneId);
            flushChatTabViewportHandoff([
              args.tabId,
              ...(targetInstanceId === null ? [] : [targetInstanceId]),
              ...(sourcePane !== null &&
              sourcePane.tabInstanceIds.length === 1 &&
              args.sourcePaneId !== args.targetPaneId
                ? paneRemovalDissolveHandoffTargets(
                    before.root,
                    args.sourcePaneId,
                  )
                : []),
            ]);
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) => {
              const sourcePane = findPaneById(canvas.root, args.sourcePaneId);
              const node = canvas.tilesByInstanceId[args.tabId];
              if (sourcePane === null || node === undefined) return canvas;
              return splitPaneAtEdge(canvas, args.targetPaneId, args.position, {
                kind: "tab",
                sourcePaneId: args.sourcePaneId,
                tabId: args.tabId,
                node,
              });
            }),
          );
          const after = canvasForExistingTab(get(), tabId);
          const analyticsTarget =
            node === undefined
              ? null
              : analyticsTargetForCanvasTileType(node.type);
          if (before !== after && analyticsTarget !== null) {
            Analytics.getInstance().track(AnalyticsEvent.TabSplit, {
              target: analyticsTarget,
            });
          }
        },

        prepareSplitPaneWithTabFocusTarget: (tabId, args) => {
          const before = canvasForExistingTab(get(), tabId);
          get().splitPaneWithTab(tabId, args);
          const after = canvasForExistingTab(get(), tabId);
          const target = changedCanvasFocusTarget(before, after);
          return target;
        },

        splitPaneEmptyInTab: (tabId, targetPaneId, direction) => {
          let newPaneId: string | null = null;
          // Ticket 20: an empty placeholder pane can still WRAP the target
          // (same `insertPaneAtEdge` mechanism as `splitPaneWithNode`), even
          // though this action opens no content of its own.
          const before = canvasForExistingTab(get(), tabId);
          if (before !== null) {
            const targetPane = findPaneById(before.root, targetPaneId);
            const targetInstanceId =
              targetPane === null
                ? null
                : resolveActivePaneTab(
                    targetPane.activeTabId,
                    targetPane.tabInstanceIds,
                  );
            if (targetInstanceId !== null) {
              flushChatTabViewportHandoff([targetInstanceId]);
            }
          }
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined) return state;
            const canvas = state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
            const nextCanvas = splitPaneEmpty(canvas, targetPaneId, direction);
            if (nextCanvas === canvas) return state;
            newPaneId = nextCanvas.activePaneId;
            return {
              canvasByTabId: {
                ...state.canvasByTabId,
                [tabId]: nextCanvas,
              },
            };
          });
          return newPaneId;
        },

        prepareSplitPaneEmptyFocusTarget: (tabId, targetPaneId, direction) => {
          const paneId = get().splitPaneEmptyInTab(
            tabId,
            targetPaneId,
            direction,
          );
          const target =
            paneId === null ? null : { paneId, tileInstanceId: undefined };
          return target;
        },

        splitPaneEmptyRightInTab: (tabId, targetPaneId) =>
          get().splitPaneEmptyInTab(tabId, targetPaneId, "horizontal"),

        closeCanvasTab: (tabId, paneId, tileTabId) => {
          const beforeCanvas = get().canvasByTabId[tabId];
          // Ticket 20: closing a pane's LAST tab removes the pane itself
          // (`closeTab` falls through to `closePane`), which can dissolve its
          // parent group and remount a sibling's painted chat. Predict this
          // BEFORE `set()`, from the state as it stands right now.
          if (beforeCanvas !== undefined) {
            const pane = findPaneById(beforeCanvas.root, paneId);
            if (pane !== null && pane.tabInstanceIds.length === 1) {
              flushChatTabViewportHandoff(
                paneRemovalDissolveHandoffTargets(beforeCanvas.root, paneId),
              );
            }
          }
          // `tileTabId` is a tab instanceId; pendingCreate tracking is keyed by
          // content id, so resolve the closed tab's content id before clearing.
          set((state) => {
            const canvas = state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
            const pane = findPaneById(canvas.root, paneId);
            const contentId =
              pane !== null && pane.tabInstanceIds.includes(tileTabId)
                ? (canvas.tilesByInstanceId[tileTabId]?.id ?? null)
                : null;
            const pendingNext =
              contentId === null
                ? state.pendingCreateArtifactIds
                : withoutId(state.pendingCreateArtifactIds, contentId);
            const updated = updateTabCanvas(state, tabId, (canvas) =>
              closeTileTab(canvas, paneId, tileTabId),
            );
            return pendingNext === state.pendingCreateArtifactIds
              ? updated
              : { ...updated, pendingCreateArtifactIds: pendingNext };
          });
          trackClosedCanvasTiles(beforeCanvas, get().canvasByTabId[tabId]);
        },

        prepareCloseCanvasTabFocusTarget: (tabId, paneId, tileTabId) => {
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().closeCanvasTab(tabId, paneId, tileTabId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = changedNestedFocusTarget(before, after);
          return target;
        },

        prepareCloseOtherCanvasTabsFocusTarget: (tabId, paneId, tileTabId) => {
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().closeOtherCanvasTabs(tabId, paneId, tileTabId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = changedNestedFocusTarget(before, after);
          return target;
        },

        closeOtherCanvasTabs: (tabId, paneId, tileTabId) => {
          const beforeCanvas = get().canvasByTabId[tabId];
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              closeOtherTileTabs(canvas, paneId, tileTabId),
            ),
          );
          trackClosedCanvasTiles(beforeCanvas, get().canvasByTabId[tabId]);
        },

        closeRightCanvasTabs: (tabId, paneId, tileTabId) => {
          const beforeCanvas = get().canvasByTabId[tabId];
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              closeRightTabs(canvas, paneId, tileTabId),
            ),
          );
          trackClosedCanvasTiles(beforeCanvas, get().canvasByTabId[tabId]);
        },

        prepareCloseRightCanvasTabsFocusTarget: (tabId, paneId, tileTabId) => {
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().closeRightCanvasTabs(tabId, paneId, tileTabId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = changedNestedFocusTarget(before, after);
          return target;
        },

        closeAllCanvasTabs: (tabId, paneId) => {
          const beforeCanvas = get().canvasByTabId[tabId];
          // Ticket 20: `closeAllTabs` always falls through to `closePane` for
          // a non-empty pane - same dissolve risk as `closeCanvasTab`.
          if (beforeCanvas !== undefined) {
            const pane = findPaneById(beforeCanvas.root, paneId);
            if (pane !== null && pane.tabInstanceIds.length > 0) {
              flushChatTabViewportHandoff(
                paneRemovalDissolveHandoffTargets(beforeCanvas.root, paneId),
              );
            }
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              closeAllTabs(canvas, paneId),
            ),
          );
          trackClosedCanvasTiles(beforeCanvas, get().canvasByTabId[tabId]);
        },

        prepareCloseAllCanvasTabsFocusTarget: (tabId, paneId) => {
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().closeAllCanvasTabs(tabId, paneId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = changedNestedFocusTarget(before, after);
          return target;
        },

        closeCanvasPane: (tabId, paneId) => {
          const beforeCanvas = get().canvasByTabId[tabId];
          // Ticket 20: same dissolve risk as `closeCanvasTab`/`closeAllCanvasTabs`
          // - `closePane` always removes the whole pane.
          if (beforeCanvas !== undefined) {
            flushChatTabViewportHandoff(
              paneRemovalDissolveHandoffTargets(beforeCanvas.root, paneId),
            );
          }
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              closePane(canvas, paneId),
            ),
          );
          trackClosedCanvasTiles(beforeCanvas, get().canvasByTabId[tabId]);
        },

        prepareCloseCanvasPaneFocusTarget: (tabId, paneId) => {
          const before = currentNestedFocusTargetForTab(get(), tabId);
          get().closeCanvasPane(tabId, paneId);
          const after = currentNestedFocusTargetForTab(get(), tabId);
          const target = changedNestedFocusTarget(before, after);
          return target;
        },

        resizeSplitInTab: (tabId, groupId, sizes) => {
          set((state) =>
            updateTabCanvas(state, tabId, (canvas) =>
              resizeSplit(canvas, groupId, sizes),
            ),
          );
        },

        prepareResizeSplitFocusTarget: (tabId, groupId, sizes) => {
          get().resizeSplitInTab(tabId, groupId, sizes);
          return null;
        },

        renameArtifactInTab: (tabId, artifactId, name) => {
          const trimmed = name.trim();
          if (trimmed.length === 0) return;
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined) return state;
            const canvasPatch = updateTabCanvas(state, tabId, (canvas) =>
              renameArtifact(canvas, artifactId, trimmed),
            );
            const records = state.artifactTreeByEpicId[tab.epicId] ?? [];
            const target = records.find((r) => r.id === artifactId);
            if (target === undefined || target.name === trimmed) {
              return canvasPatch;
            }
            return {
              ...canvasPatch,
              artifactTreeByEpicId: {
                ...state.artifactTreeByEpicId,
                [tab.epicId]: records.map((r) =>
                  r.id === artifactId ? { ...r, name: trimmed } : r,
                ),
              },
            };
          });
        },

        updateTerminalNameSnapshots: (hostId, sessionId, name) => {
          const trimmed = name.trim();
          if (trimmed.length === 0) return;
          set((state) => {
            const entries = Object.entries(state.canvasByTabId).map(
              ([tabId, canvas]) =>
                [
                  tabId,
                  canvas === undefined
                    ? canvas
                    : renameTerminalTiles(canvas, hostId, sessionId, trimmed),
                ] as const,
            );
            if (
              entries.every(
                ([tabId, canvas]) => canvas === state.canvasByTabId[tabId],
              )
            ) {
              return state;
            }
            return { canvasByTabId: Object.fromEntries(entries) };
          });
        },

        seedEpic: (epicId, tab, artifacts) => {
          set((state) => {
            const existing = state.tabsById[tab.tabId];
            if (existing !== undefined) {
              return {
                artifactTreeByEpicId: {
                  ...state.artifactTreeByEpicId,
                  [epicId]: artifacts,
                },
                activeTabId: tab.tabId,
                mostRecentTabIdByEpicId: {
                  ...state.mostRecentTabIdByEpicId,
                  [epicId]: tab.tabId,
                },
              };
            }
            const viewTab: EpicViewTab = {
              tabId: tab.tabId,
              epicId,
              name: tab.name,
            };
            return {
              tabsById: { ...state.tabsById, [viewTab.tabId]: viewTab },
              canvasByTabId: {
                ...state.canvasByTabId,
                [viewTab.tabId]: createEmptyCanvas(),
              },
              openTabOrder: [...state.openTabOrder, viewTab.tabId],
              activeTabId: viewTab.tabId,
              mostRecentTabIdByEpicId: {
                ...state.mostRecentTabIdByEpicId,
                [epicId]: viewTab.tabId,
              },
              artifactTreeByEpicId: {
                ...state.artifactTreeByEpicId,
                [epicId]: artifacts,
              },
            };
          });
        },

        createEpicFromPrompt: (prompt) => {
          const epicId = uuidv4();
          // `createEpicName` yields "" for an empty/whitespace prompt; this create
          // path bakes a non-empty stored tab name, so apply the "Untitled task"
          // fallback here.
          const name = createEpicName(prompt) || UNTITLED_EPIC_TITLE;
          const tabId = uuidv4();
          const tab: EpicViewTab = {
            tabId,
            epicId,
            name,
          };
          set((state) => ({
            tabsById: { ...state.tabsById, [tabId]: tab },
            canvasByTabId: {
              ...state.canvasByTabId,
              [tabId]: createEmptyCanvas(),
            },
            openTabOrder: [...state.openTabOrder, tabId],
            activeTabId: tabId,
            mostRecentTabIdByEpicId: {
              ...state.mostRecentTabIdByEpicId,
              [epicId]: tabId,
            },
            artifactTreeByEpicId: {
              ...state.artifactTreeByEpicId,
              [epicId]: [],
            },
          }));
          return { epicId, name, tabId };
        },

        addRootArtifact: (tabId, type, hostId) => {
          let createdId = "";
          set((state) => {
            const tab = state.tabsById[tabId];
            if (tab === undefined) return state;
            const result = appendArtifactRecord({
              state,
              epicId: tab.epicId,
              parentId: null,
              type,
              hostId,
            });
            if (result === null) return state;
            createdId = result.id;
            if (result.node === null) return result.patch;
            const node = result.node;
            return {
              ...result.patch,
              ...updateTabCanvas(state, tabId, (canvas) =>
                openTile(canvas, node, false, null),
              ),
            };
          });
          return createdId;
        },

        addChildArtifact: (epicId, parentId, type, hostId) => {
          let createdId: string | null = null;
          set((state) => {
            const result = appendArtifactRecord({
              state,
              epicId,
              parentId,
              type,
              hostId,
            });
            if (result === null) return state;
            createdId = result.id;
            return result.patch;
          });
          return createdId;
        },

        markArtifactSelfDeleted: (artifactId) => {
          // Pending-title map is id-keyed so a stale spinner anchor would
          // orphan the 30s backstop timer until it fires as a no-op.
          // `clearScheduledTitlePending` is a no-op when the id isn't present.
          clearScheduledTitlePending(chatTitleTimers, artifactId);
          set((s) => {
            const next = withId(s.selfDeletedArtifactIds, artifactId);
            const nextChat = Object.hasOwn(s.pendingChatTitles, artifactId)
              ? (() => {
                  const c = { ...s.pendingChatTitles };
                  delete c[artifactId];
                  return c;
                })()
              : s.pendingChatTitles;
            if (
              next === s.selfDeletedArtifactIds &&
              nextChat === s.pendingChatTitles
            ) {
              return s;
            }
            return {
              selfDeletedArtifactIds: next,
              pendingChatTitles: nextChat,
            };
          });
        },

        unmarkArtifactSelfDeleted: (artifactId) => {
          set((s) => {
            const next = withoutId(s.selfDeletedArtifactIds, artifactId);
            return next === s.selfDeletedArtifactIds
              ? s
              : { selfDeletedArtifactIds: next };
          });
        },

        markArtifactPendingCreate: (artifactId) => {
          set((s) => {
            const next = withId(s.pendingCreateArtifactIds, artifactId);
            return next === s.pendingCreateArtifactIds
              ? s
              : { pendingCreateArtifactIds: next };
          });
        },

        unmarkArtifactPendingCreate: (artifactId) => {
          set((s) => {
            const next = withoutId(s.pendingCreateArtifactIds, artifactId);
            const nextClosedTilePayloads = clearClosedTilePendingCreate(
              s.closedTilePayloadsByTabId,
              artifactId,
            );
            return next === s.pendingCreateArtifactIds &&
              nextClosedTilePayloads === s.closedTilePayloadsByTabId
              ? s
              : {
                  pendingCreateArtifactIds: next,
                  closedTilePayloadsByTabId: nextClosedTilePayloads,
                };
          });
        },

        beginPreAckRootCreate: (epicId, tempId, name) => {
          set((s) => {
            const cur = s.preAckRootCreatesByEpic[epicId] ?? [];
            return {
              preAckRootCreatesByEpic: {
                ...s.preAckRootCreatesByEpic,
                [epicId]: [...cur, { tempId, name }],
              },
            };
          });
        },

        endPreAckRootCreate: (epicId, tempId) => {
          set((s) => {
            const cur = s.preAckRootCreatesByEpic[epicId];
            if (cur === undefined) return s;
            return {
              preAckRootCreatesByEpic: {
                ...s.preAckRootCreatesByEpic,
                [epicId]: cur.filter((e) => e.tempId !== tempId),
              },
            };
          });
        },

        registerPendingRootCreate: (epicId, pendingId, name) => {
          set((s) => {
            const cur = s.pendingRootCreatesByEpic[epicId] ?? [];
            return {
              pendingRootCreatesByEpic: {
                ...s.pendingRootCreatesByEpic,
                [epicId]: [...cur, { id: pendingId, name }],
              },
            };
          });
        },

        clearPendingRootCreate: (epicId, pendingId) => {
          set((s) => {
            const cur = s.pendingRootCreatesByEpic[epicId];
            if (cur === undefined || !cur.some((e) => e.id === pendingId)) {
              return s;
            }
            return {
              pendingRootCreatesByEpic: {
                ...s.pendingRootCreatesByEpic,
                [epicId]: cur.filter((e) => e.id !== pendingId),
              },
            };
          });
        },

        markEpicTitlePending: (epicId, expectedTitle) => {
          scheduleTitlePendingClear(epicTitleTimers, epicId, () =>
            get().clearEpicTitlePending(epicId),
          );
          set((s) => ({
            pendingEpicTitles: {
              ...s.pendingEpicTitles,
              [epicId]: { expectedTitle, startedAt: Date.now() },
            },
          }));
        },

        clearEpicTitlePending: (epicId) => {
          clearScheduledTitlePending(epicTitleTimers, epicId);
          set((s) => {
            if (!Object.hasOwn(s.pendingEpicTitles, epicId)) return s;
            const next = { ...s.pendingEpicTitles };
            delete next[epicId];
            return { pendingEpicTitles: next };
          });
        },

        markChatTitlePending: (chatId, expectedTitle) => {
          scheduleTitlePendingClear(chatTitleTimers, chatId, () =>
            get().clearChatTitlePending(chatId),
          );
          set((s) => ({
            pendingChatTitles: {
              ...s.pendingChatTitles,
              [chatId]: { expectedTitle, startedAt: Date.now() },
            },
          }));
        },

        clearChatTitlePending: (chatId) => {
          clearScheduledTitlePending(chatTitleTimers, chatId);
          set((s) => {
            if (!Object.hasOwn(s.pendingChatTitles, chatId)) return s;
            const next = { ...s.pendingChatTitles };
            delete next[chatId];
            return { pendingChatTitles: next };
          });
        },

        clearAllTitleGenerationPending: () => {
          clearAllScheduledTitlePending(epicTitleTimers);
          clearAllScheduledTitlePending(chatTitleTimers);
          set({
            pendingEpicTitles: {},
            pendingChatTitles: {},
          });
        },
      };
    },
    {
      ...basePersistOptions(epicCanvasKey(null)),
      storage: createJSONStorage(() => epicCanvasStorage),
      partialize: (state) => ({
        tabsById: state.tabsById,
        canvasByTabId: serializeCanvasByTabIdForLocalPersist(
          state.canvasByTabId,
        ),
        openTabOrder: state.openTabOrder,
        activeTabId: state.activeTabId,
        mostRecentTabIdByEpicId: state.mostRecentTabIdByEpicId,
        artifactTreeByEpicId: state.artifactTreeByEpicId,
      }),
      merge: (persistedState, currentState) => {
        const sanitized = sanitizePersistedCanvasState(persistedState);
        // Never throw here, even in dev/test: zustand's `hydrate()` swallows
        // a `merge()` throw internally and never rethrows, which also skips
        // `set(stateFromStorage, true)` - so `hasHydrated`/`onFinishHydration`
        // never fire and consumers waiting on hydration (history-prune-
        // provider.tsx, epic-tab-existence-reconciler.tsx) hang forever. Fail
        // closed by rejecting the candidate and returning normally instead;
        // the diagnostic below is the surfaced signal in every mode.
        const accepted = guardCanvasMutation(currentState, sanitized, {
          ingressContext: "persisted-migration",
          throwOnViolation: false,
        });
        if (!accepted) return currentState;
        return {
          ...currentState,
          ...sanitized,
        };
      },
    },
  ),
);

const rawPublicSetState = useEpicCanvasStore.setState.bind(useEpicCanvasStore);
/**
 * Guards every PUBLIC-API canvas mutation. The closure-local `set` above
 * delegates here; anything else reaching the store through the public API -
 * `applyEpicCanvasDesktopProjection`, or a future caller - goes through this
 * wrapper too. Reassigning `setState` itself - rather than adding a guard at
 * each known call site - means a caller added later is covered too. This
 * path is always strict: `resolveTabEpicIdentity` below is the one function
 * that changes a tab's epicId, and it bypasses this wrapper entirely,
 * committing straight through `rawPublicSetState` - provenance is enforced
 * by that module privacy, not by a parameter threaded through this guard.
 */
useEpicCanvasStore.setState = (
  partial:
    | EpicCanvasStore
    | Partial<EpicCanvasStore>
    | ((state: EpicCanvasStore) => EpicCanvasStore | Partial<EpicCanvasStore>),
  replace: boolean | undefined,
): void => {
  const state = useEpicCanvasStore.getState();
  const resolved = typeof partial === "function" ? partial(state) : partial;
  if (
    resolved !== state &&
    !guardCanvasMutation(state, resolved, {
      ingressContext: "public-setstate",
      throwOnViolation: import.meta.env.DEV,
    })
  ) {
    return;
  }
  if (replace === true) {
    // `replace: true` callers (store resets in tests) pass a full state by
    // contract; the union param type above can't express that correlation to
    // zustand's overloaded signature without this cast.
    rawPublicSetState(resolved as EpicCanvasStore, true);
  } else {
    rawPublicSetState(resolved);
  }
};

/**
 * The ONLY function authorized to change a tab's `epicId` for an
 * already-live tile set. It bypasses the guarded public `setState` wrapper
 * above (which is always strict) and commits through `rawPublicSetState`
 * directly - provenance is enforced by this function being the sole caller
 * of that module-private raw setter, not by a parameter every guarded
 * ingress has to understand. `tab-command-coordinator.ts`'s
 * `resolveMigratedEpicActivation` and `completePhaseMigration` are its only
 * two callers; both publish success from a POST-commit `getState()`
 * read-back rather than trusting this function's return, because a
 * synchronous subscriber can re-enter and move the same tab's epicId again
 * before the outer caller regains control (see their own doc comments) - so
 * this function reports nothing about outcome.
 *
 * Also owns the `mostRecentTabIdByEpicId` reindex (move the entry from the
 * prior epicId to the resolved one) - both call sites needed the exact same
 * bookkeeping, so it lives here once instead of twice.
 *
 * Preconditions, enforced here rather than trusted from the caller:
 * - the tab exists;
 * - `resolvedEpicId` actually differs from the tab's current epicId (a
 *   same-value call is a silent no-op, not an error - safe for an
 *   idempotent retry);
 * - the tab's CURRENT epicId equals `expectedCurrentEpicId`. This is the
 *   strongest precondition genuinely available to BOTH real callers today:
 *   `resolveMigratedEpicActivation` already checks the tab's epicId against
 *   `target.sourceEpicId` before calling, and `completePhaseMigration`
 *   already checks it against `command.phaseId` (via `surfaceMode.phaseId`).
 *   A tab-level `surfaceMode.kind === "phase-migration"` check was
 *   considered and REJECTED as a UNIVERSAL precondition here:
 *   `resolveMigratedEpicActivation`'s own existing check never examines
 *   `surfaceMode` at all (its target is a more general "migrated-epic"
 *   activation, not necessarily a phase-migration tab), so requiring it
 *   would incorrectly narrow this action to serve only
 *   `completePhaseMigration`. Each coordinator call site keeps its own
 *   additional, shape-specific precondition (surfaceMode+phaseId, or
 *   sourceEpicId-or-already-resolved) before ever calling this action - this
 *   action's `expectedCurrentEpicId` check is a second, independent layer
 *   against a stale/racing caller, not a replacement for those.
 */
export function resolveTabEpicIdentity(
  tabId: string,
  expectedCurrentEpicId: string,
  resolvedEpicId: string,
): void {
  const state = useEpicCanvasStore.getState();
  const current = state.tabsById[tabId];
  if (current === undefined) return;
  if (current.epicId === resolvedEpicId) return;
  if (current.epicId !== expectedCurrentEpicId) {
    appLogger.error(
      "resolveTabEpicIdentity precondition failed: tab's current epicId does not match the caller's expectation",
      {
        tabId,
        expectedCurrentEpicId,
        actualCurrentEpicId: current.epicId,
        resolvedEpicId,
      },
      new Error("resolveTabEpicIdentity precondition failed"),
    );
    return;
  }
  const nextMostRecentTabIdByEpicId = {
    ...state.mostRecentTabIdByEpicId,
    [resolvedEpicId]: tabId,
  };
  if (nextMostRecentTabIdByEpicId[expectedCurrentEpicId] === tabId) {
    delete nextMostRecentTabIdByEpicId[expectedCurrentEpicId];
  }
  rawPublicSetState({
    tabsById: {
      ...state.tabsById,
      [tabId]: { ...current, epicId: resolvedEpicId },
    },
    mostRecentTabIdByEpicId: nextMostRecentTabIdByEpicId,
  });
}

export function applyEpicCanvasDesktopProjection(
  snapshot: DesktopPerWindowSnapshot,
): void {
  applyingDesktopProjection = true;
  try {
    // The guarded public `setState` wrapper validates this patch itself -
    // no separate guard call needed here, it would just re-check the
    // identical patch a second time.
    useEpicCanvasStore.setState((state) =>
      buildDesktopProjectionPatch(state, snapshot),
    );
  } finally {
    // Always release the suppression flag, even when the dev/test guard
    // throws mid-`setState` - otherwise every later outbound projection is
    // silently dropped by the subscriber below for the module's lifetime.
    applyingDesktopProjection = false;
  }
}

useEpicCanvasStore.subscribe((state) => {
  if (desktopProjectionBridge === null || applyingDesktopProjection) return;
  void desktopProjectionBridge.update({
    epicTabs: projectTabsForDesktop(state),
    activeTabId: state.activeTabId,
    canvasByTabId: projectCanvasByTabIdForDesktop(state),
  });
});

/**
 * Ticket 15 review round 3: resolves the `(epicId, chatId)` identity a
 * removed tile HAD, using the canvas/tab snapshots as they stood just
 * BEFORE this update - `tilesByInstanceId` lives on `canvasByTabId`, but
 * `epicId` lives on the PARALLEL `tabsById` map (`tabsById[tabId].epicId`),
 * and a whole-tab close/delete can clear both together in the SAME update,
 * so a removed tile's tab record can already be gone from the CURRENT
 * state by the time this runs - both snapshots must be the prior ones.
 * `null` for a non-chat tile (diff/terminal/workspace-file tiles have no
 * dual-key persistence family) or if either snapshot is missing the entry.
 */
function resolveClosedChatIdentity(
  priorCanvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
  priorTabsById: Readonly<Record<string, EpicViewTab | undefined>>,
  tileInstanceId: string,
): ChatTabPersistenceIdentity | null {
  for (const [tabId, canvas] of Object.entries(priorCanvasByTabId)) {
    if (canvas === undefined) continue;
    const node = canvas.tilesByInstanceId[tileInstanceId];
    if (node === undefined) continue;
    if (!("type" in node) || node.type !== "chat") return null;
    const epicId = priorTabsById[tabId]?.epicId;
    if (epicId === undefined) return null;
    return { tileInstanceId, epicId, chatId: node.id };
  }
  return null;
}

// Evict session scroll anchors for tile instanceIds removed from the canvas.
// `useScrollRestoration` also checks tile liveness before unmount persistence,
// so a close cannot clear an anchor here and then have the unmount cleanup
// re-save it.
let previousTileInstanceIds: ReadonlySet<string> = new Set<string>();
let previousCanvasByTabId: Readonly<
  Record<string, EpicCanvasState | undefined>
> | null = null;
let previousTabsById: Readonly<Record<string, EpicViewTab | undefined>> | null =
  null;
useEpicCanvasStore.subscribe((state) => {
  // Ticket 15 review round 3: `tabsById` (epicId) and `canvasByTabId` (the
  // tile tree) can update in SEPARATE `set()` calls (e.g. `openEpicTab`
  // creates the tab record before any tile is opened into it) - tracking
  // this UNCONDITIONALLY, not gated behind the `canvasByTabId` equality
  // check below, is what keeps it from going stale relative to whichever
  // `canvasByTabId` snapshot this sweep ends up diffing against.
  const priorTabsById = previousTabsById;
  previousTabsById = state.tabsById;
  // Tile membership only changes when the canvas map itself changes; skip the
  // live-id scan for unrelated writes (active tab, titles, pane sizes, ...).
  if (state.canvasByTabId === previousCanvasByTabId) return;
  const priorCanvasByTabId = previousCanvasByTabId;
  previousCanvasByTabId = state.canvasByTabId;
  const current = collectLiveTileInstanceIds(state.canvasByTabId);
  const removed = [...previousTileInstanceIds].filter(
    (instanceId) => !current.has(instanceId),
  );
  previousTileInstanceIds = current;
  if (removed.length > 0) {
    // Ticket 15 review round 3 (the ONE close-commit choke point): promote
    // each removed chat tile's live tab-side state to durable BEFORE any
    // of the eviction calls below run - this is the only place that can
    // commit for an INACTIVE (never-mounted) view's close, since it reads
    // store state directly rather than depending on a component's own
    // unmount lifecycle firing (which, for an inactive tab, never does).
    if (priorCanvasByTabId !== null && priorTabsById !== null) {
      for (const instanceId of removed) {
        const identity = resolveClosedChatIdentity(
          priorCanvasByTabId,
          priorTabsById,
          instanceId,
        );
        if (identity !== null) promoteChatTabPersistenceToDurable(identity);
      }
    }
    useTileScrollAnchorStore.getState().clearAnchors(removed);
    // Ticket 5: chat-tile-only per-tab persistence, evicted the same way -
    // proactively on a permanent close, not just LRU/registry-capped. The
    // reading-position cache and the collapse-state registries key by the
    // exact same tile instanceId, so one `removed` list covers all of them;
    // tool/subagent are global stores namespaced by that id via `reset`.
    evictChatTabState(removed);
    evictPendingHydrationRestores(removed);
    evictActivityGroupOpenStores(removed);
    evictA2AOpenStores(removed);
    // F4 (ticket 5 review): tile-find serves every tile kind, not just chat -
    // a tile whose adapter unregistered while still live (switched-away, not
    // closed) is skipped by scheduleUiReclaim's own liveness check and never
    // revisited if it is later closed without remounting. This sweep is that
    // revisit.
    evictTileFindUi(removed);
    // Ticket 15: the minimap active entry is the 7th per-tab registry -
    // same tab-key sweep, same "durable chat-key entry survives" contract as
    // the others above.
    evictChatTurnMinimapActiveEntries(removed);
    removed.forEach((instanceId) => {
      useToolOpenStore.getState().reset(instanceId);
      useSubagentOpenStore.getState().reset(instanceId);
      // Ticket 15 review round 3: bounds the initialized-scope markers -
      // this tileInstanceId can never be seen again (a reopen always mints
      // a fresh one), so nothing else will ever need this entry.
      toolOpenInitializedScopes.delete(instanceId);
      subagentOpenInitializedScopes.delete(instanceId);
    });
  }
});

export {
  pendingTitleVisible,
  pendingTitleVisibleAutoPurge,
} from "@/stores/epics/canvas/canvas-title-timers";
export {
  collectOpenEpicIds,
  epicTabName,
  findOpenArtifactInTab,
  getCanvasRootForTab,
  isTileRefRecordLive,
  makeSelectActiveEpicArtifactId,
  makeSelectActiveEpicArtifactRef,
  makeSelectEpicArtifactRecords,
  makeSelectEpicCanvas,
  makeSelectEpicTab,
  makeSelectIsActiveEpicArtifact,
  makeSelectIsActivePane,
  makeSelectIsActiveTile,
  makeSelectTabActivation,
  useActiveEpicArtifactId,
  useActiveEpicArtifactRef,
  useActiveEpicId,
  useActiveTabId,
  useEpicArtifactRecords,
  useEpicCanvas,
  useEpicTab,
  useIsActiveEpicArtifact,
  useIsActivePane,
  useIsActiveTile,
  useOpenEpicTabs,
  usePaneTabRefs,
  useTabActivation,
} from "@/stores/epics/canvas/canvas-selectors";
