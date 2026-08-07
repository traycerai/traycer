import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  PaneActivationFocusIntentContext,
  registerHostedPaneActivationClaim,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";
import { cn } from "@/lib/utils";
import {
  useEpicCanvasStore,
  useIsActivePane,
  usePaneTabRefs,
} from "@/stores/epics/canvas/store";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import {
  useEpicArtifact,
  useEpicPermissionRole,
  useEpicSnapshotLoaded,
  type EpicArtifactProjection,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
} from "@/lib/epic-selectors";
import { EpicNodeTile } from "@/components/epic-canvas/renderers/epic-node-tile";
import { PaneDropZone } from "@/components/epic-canvas/dnd/pane-drop-zone";
import {
  isPersistentTerminalSurface,
  useMountedPaneTabs,
} from "@/components/epic-canvas/canvas/use-mounted-pane-tabs";
import {
  PaneFocusProbeContext,
  usePaneFocusProbe,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
  SplitDirection,
  TilePane,
} from "@/stores/epics/canvas/types";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";
import {
  isBlankTileRef,
  isCommGraphTileRef,
  isDiffTileRef,
  isManagedCommandOutputTileRef,
  isPrDetailTileRef,
  isPrDiffTileRef,
} from "@/stores/epics/canvas/types";
import { resolveActivePaneTab } from "@/stores/epics/canvas/tile-tree";
import { surfaceOwnerFor } from "@/components/epic-canvas/surface-host/surface-owner";
import { TileSurfaceSlot } from "@/components/epic-canvas/surface-host/tile-surface-slot";
import { reportChatRemoteDeletionState } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import { HOSTED_TILE_RECORD_SELECTOR } from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import {
  TILE_KIND_GIT_DIFF,
  TILE_KIND_PR_DETAIL,
  TILE_KIND_PR_DIFF,
  TILE_KIND_SNAPSHOT_DIFF,
} from "@/stores/epics/canvas/tile-kinds";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { useRenameCanvasTab } from "@/components/epic-canvas/canvas/use-rename-canvas-tab";
import {
  useLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { isEditableRole } from "@/lib/epic-permissions";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";

interface TabGroupViewProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly pane: TilePane;
}

function positionFor(
  axis: SplitDirection,
  leading: boolean,
): "left" | "right" | "top" | "bottom" {
  if (axis === "horizontal") return leading ? "left" : "right";
  return leading ? "top" : "bottom";
}

function panelIdForTabType(
  tabType: EpicCanvasTileRef["type"] | undefined,
): LeftPanelId {
  if (tabType === "chat" || tabType === "terminal-agent") return "chats";
  if (tabType === "terminal") return "terminals";
  if (tabType === TILE_KIND_GIT_DIFF) return "git-diff";
  if (tabType === TILE_KIND_SNAPSHOT_DIFF) return "chats";
  if (tabType === WORKSPACE_FILE_TAB_KIND) return "file-tree";
  if (tabType === TILE_KIND_PR_DETAIL) return "pull-requests";
  if (tabType === TILE_KIND_PR_DIFF) return "pull-requests";
  return "artifacts";
}

/**
 * Renders one VS Code-style tab group (a tree pane): tab strip on top, body
 * for the active tab below. Owns the body-edge DnD: drops on body edges
 * split the pane; drops on body center add the tab to this pane.
 *
 * Memoized: `pane` identity is structurally shared by the tree ops, so a
 * mutation elsewhere in the canvas leaves this view's props identity-equal
 * and it bails out entirely. Tab payloads are subscribed per-pane via
 * `usePaneTabRefs`.
 */
export const TabGroupView = memo(function TabGroupView(
  props: TabGroupViewProps,
) {
  const { epicId, tabId, pane } = props;
  const tabs = usePaneTabRefs(tabId, pane);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );
  const prepareSetActiveTilePaneFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTilePaneFocusTarget,
  );
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const prepareCloseCanvasPaneFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasPaneFocusTarget,
  );
  const prepareCloseOtherCanvasTabsFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseOtherCanvasTabsFocusTarget,
  );
  const prepareCloseRightCanvasTabsFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseRightCanvasTabsFocusTarget,
  );
  const prepareCloseAllCanvasTabsFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseAllCanvasTabsFocusTarget,
  );
  const promotePreviewInTab = useEpicCanvasStore((s) => s.promotePreviewInTab);
  const prepareSplitPaneEmptyFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSplitPaneEmptyFocusTarget,
  );
  const prepareSplitPaneWithTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSplitPaneWithTabFocusTarget,
  );
  const prepareOpenBlankTabInPaneFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenBlankTabInPaneFocusTarget,
  );
  const setActivePanelIdAndExpand = useLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const renameTab = useRenameCanvasTab(epicId, tabId);
  const permissionRole = useEpicPermissionRole();
  const canRenameTabs = isEditableRole(permissionRole);

  // Per-pane boolean (not the raw `activePaneId`) so switching the active
  // pane re-renders only the two panes whose active state flips, not all of
  // them. See `makeSelectIsActivePane`.
  const globallyActive = useIsActivePane(tabId, pane.id);
  // Whether the canvas root is a group - i.e. more than one pane exists.
  const canvasIsSplit = useEpicCanvasStore(
    (s) => s.canvasByTabId[tabId]?.root?.kind === "group",
  );
  // Hide the strip only for a lone, empty root pane - there is nothing to
  // act on. Every other pane keeps its strip with the split + close
  // buttons; an empty pane inside a split still needs them.
  const showTabStrip = pane.tabInstanceIds.length > 0 || canvasIsSplit;

  const handleSelectTab = useCallback(
    (groupId: string, tileTabId: string) => {
      navigateNested(epicId, tabId, () =>
        prepareSetActiveTileTabFocusTarget(tabId, groupId, tileTabId),
      );
    },
    [epicId, navigateNested, prepareSetActiveTileTabFocusTarget, tabId],
  );

  const handleCloseTab = useCallback(
    (groupId: string, tileTabId: string) => {
      navigateNested(epicId, tabId, () =>
        prepareCloseCanvasTabFocusTarget(tabId, groupId, tileTabId),
      );
    },
    [epicId, navigateNested, prepareCloseCanvasTabFocusTarget, tabId],
  );

  const handlePromotePreview = useCallback(
    (groupId: string) => {
      promotePreviewInTab(tabId, groupId);
    },
    [promotePreviewInTab, tabId],
  );

  const handleSplit = useCallback(
    (groupId: string, direction: SplitDirection) => {
      // The new empty pane self-renders the inline opener (PaneOpener); no
      // explicit trigger needed.
      navigateNested(epicId, tabId, () =>
        prepareSplitPaneEmptyFocusTarget(tabId, groupId, direction),
      );
    },
    [epicId, navigateNested, prepareSplitPaneEmptyFocusTarget, tabId],
  );

  const handleCloseGroup = useCallback(
    (groupId: string) => {
      navigateNested(epicId, tabId, () =>
        prepareCloseCanvasPaneFocusTarget(tabId, groupId),
      );
    },
    [epicId, navigateNested, prepareCloseCanvasPaneFocusTarget, tabId],
  );

  const handleOpenBlankTab = useCallback(
    (groupId: string) => {
      navigateNested(epicId, tabId, () =>
        prepareOpenBlankTabInPaneFocusTarget(tabId, groupId),
      );
    },
    [epicId, navigateNested, prepareOpenBlankTabInPaneFocusTarget, tabId],
  );

  const activatePane = useCallback(() => {
    if (globallyActive) return;
    navigateNested(epicId, tabId, () =>
      prepareSetActiveTilePaneFocusTarget(tabId, pane.id),
    );
  }, [
    epicId,
    globallyActive,
    navigateNested,
    pane.id,
    prepareSetActiveTilePaneFocusTarget,
    tabId,
  ]);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const paneActivation = usePaneActivationOwnership({
    active: globallyActive,
    activate: activatePane,
  });
  const { claimFocus, claimPointerDown } = paneActivation;
  const parentPaneFocusProbe = usePaneFocusProbe();
  const isPaneFocused = useCallback(
    () =>
      parentPaneFocusProbe() && paneRootRef.current?.dataset.active === "true",
    [parentPaneFocusProbe],
  );

  useLayoutEffect(
    () => registerHostedPaneActivationClaim(tabId, pane.id, claimPointerDown),
    [claimPointerDown, pane.id, tabId],
  );

  useEffect(() => {
    const claimHostedFocus = (event: globalThis.FocusEvent): void => {
      const { target } = event;
      if (!(target instanceof Element)) return;
      const ownership = resolveHostedTileOwnership(target);
      if (ownership?.paneId !== pane.id) return;
      claimFocus({
        defaultPrevented: event.defaultPrevented,
        scope: target.closest(HOSTED_TILE_RECORD_SELECTOR),
        target,
      });
    };
    // Hosted records are physical siblings of the pane root, so its React
    // focus capture handler cannot see them. Pointer claims are dispatched
    // from the surface plane's capture handler; focus keeps this document
    // bridge because focus ownership has no gesture-ordering dependency.
    document.addEventListener("focusin", claimHostedFocus);
    return () => {
      document.removeEventListener("focusin", claimHostedFocus);
    };
  }, [claimFocus, pane.id]);
  const handleSplitFromMenu = useCallback(
    (
      groupId: string,
      tileTabId: string,
      axis: SplitDirection,
      leading: boolean,
    ) => {
      const position = positionFor(axis, leading);
      const tab = tabs.find((t) => t.instanceId === tileTabId);
      if (tab === undefined) return;
      navigateNested(epicId, tabId, () =>
        prepareSplitPaneWithTabFocusTarget(tabId, {
          sourcePaneId: groupId,
          tabId: tileTabId,
          targetPaneId: groupId,
          position,
        }),
      );
    },
    [epicId, navigateNested, prepareSplitPaneWithTabFocusTarget, tabId, tabs],
  );

  const handleRevealInSidebar = useCallback(
    (tileTabId: string) => {
      const tabType = tabs.find((tab) => tab.instanceId === tileTabId)?.type;
      setActivePanelIdAndExpand(tabId, panelIdForTabType(tabType));
    },
    [tabs, setActivePanelIdAndExpand, tabId],
  );

  const handleRename = useCallback(
    (_groupId: string, tileTabId: string, title: string) => {
      const tab = tabs.find((t) => t.instanceId === tileTabId);
      if (tab === undefined) return;
      renameTab(tab, title);
    },
    [tabs, renameTab],
  );

  const activeTab = useMemo<EpicCanvasTileRef | null>(() => {
    if (tabs.length === 0) return null;
    const activeInstanceId = resolveActivePaneTab(
      pane.activeTabId,
      pane.tabInstanceIds,
    );
    const explicit =
      activeInstanceId === null
        ? undefined
        : tabs.find((t) => t.instanceId === activeInstanceId);
    return explicit ?? tabs[0];
  }, [pane.activeTabId, pane.tabInstanceIds, tabs]);
  // Keep-alive mounting policy: pinned terminals ∪ LRU(cap 3) of recently
  // active tabs, with the active tab as the LRU head (so at most 3
  // non-terminal bodies are mounted, INCLUDING the active one); a hidden
  // pane collapses to active-only(+terminals). See use-mounted-pane-tabs.ts.
  const paneVisible = usePaneVisible();
  const mountedTabIds = useMountedPaneTabs({
    activeTabId: activeTab?.instanceId ?? null,
    tabs,
    paneVisible,
  });
  const mountedTabs = useMemo(
    () => tabs.filter((tab) => mountedTabIds.has(tab.instanceId)),
    [tabs, mountedTabIds],
  );

  return (
    <div className="relative h-full min-h-0 w-full bg-canvas">
      <PaneActivationFocusIntentContext.Provider
        value={paneActivation.focusIntent}
      >
        <PaneFocusProbeContext.Provider value={isPaneFocused}>
          <div
            ref={paneRootRef}
            data-testid="tab-group"
            data-group-id={pane.id}
            data-active={globallyActive ? "true" : "false"}
            tabIndex={-1}
            className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas"
            onFocusCapture={paneActivation.onFocusCapture}
            onPointerDownCapture={paneActivation.onPointerDownCapture}
            onPointerCancelCapture={paneActivation.onPointerCancelCapture}
          >
            {showTabStrip ? (
              <TabStrip
                epicId={epicId}
                tabId={tabId}
                groupId={pane.id}
                tabs={tabs}
                activeTabId={pane.activeTabId}
                onSelectTab={handleSelectTab}
                onCloseTab={handleCloseTab}
                onPromotePreview={handlePromotePreview}
                onSplit={handleSplit}
                onCloseGroup={handleCloseGroup}
                onOpenBlankTab={handleOpenBlankTab}
                canRenameTabs={canRenameTabs}
                menuHandlers={{
                  onClose: handleCloseTab,
                  onCloseOthers: (gid, tid) =>
                    navigateNested(epicId, tabId, () =>
                      prepareCloseOtherCanvasTabsFocusTarget(tabId, gid, tid),
                    ),
                  onCloseRight: (gid, tid) =>
                    navigateNested(epicId, tabId, () =>
                      prepareCloseRightCanvasTabsFocusTarget(tabId, gid, tid),
                    ),
                  onCloseAll: (gid) =>
                    navigateNested(epicId, tabId, () =>
                      prepareCloseAllCanvasTabsFocusTarget(tabId, gid),
                    ),
                  onSplit: handleSplitFromMenu,
                  onRevealInSidebar: handleRevealInSidebar,
                  onRename: handleRename,
                }}
              />
            ) : null}
            <div
              data-testid="tab-group-body"
              className="relative flex min-h-0 flex-1 flex-col"
            >
              {activeTab === null ? (
                <PaneOpener
                  epicId={epicId}
                  tabId={tabId}
                  groupId={pane.id}
                  active={globallyActive}
                />
              ) : null}
              {activeTab !== null
                ? mountedTabs.map((tab) => {
                    const selected = activeTab.instanceId === tab.instanceId;
                    // Hidden terminals conceal via `visibility` so xterm keeps
                    // its box dimensions; hidden LRU keep-alives use
                    // `display:none` so concealed heavy bodies cost no layout
                    // or paint.
                    const terminal = isPersistentTerminalSurface(tab);
                    return (
                      <div
                        key={tab.instanceId}
                        data-testid="pane-tab-layer"
                        data-tab-instance-id={tab.instanceId}
                        data-selected={selected ? "true" : "false"}
                        tabIndex={-1}
                        className={cn(
                          "absolute inset-0 min-h-0",
                          selected && "visible pointer-events-auto",
                          !selected &&
                            terminal &&
                            "invisible pointer-events-none",
                          !selected && !terminal && "hidden",
                        )}
                        aria-hidden={selected ? undefined : true}
                      >
                        <TabBodySelectedContext.Provider value={selected}>
                          <ActiveTabBody
                            activeTab={tab}
                            epicId={epicId}
                            groupId={pane.id}
                            tabId={tabId}
                            selected={selected}
                            globallyActive={globallyActive}
                          />
                        </TabBodySelectedContext.Provider>
                      </div>
                    );
                  })
                : null}
              <PaneDropZone
                paneId={pane.id}
                viewTabId={tabId}
                tabCount={pane.tabInstanceIds.length}
              />
            </div>
          </div>
        </PaneFocusProbeContext.Provider>
      </PaneActivationFocusIntentContext.Provider>
    </div>
  );
});

export interface ActiveTabBodyProps {
  readonly activeTab: EpicCanvasTileRef;
  readonly epicId: string;
  readonly groupId: string;
  readonly tabId: string;
  readonly selected: boolean;
  readonly globallyActive: boolean;
}

/**
 * Renders one tile body with the desktop remote-deleted guard and `isActive`
 * computation. Exported so the mobile single-tile view
 * (`epic-canvas/mobile/mobile-epic-tile-view.tsx`) renders the selected tile
 * through the identical logic instead of duplicating the deleted-guard and the
 * `role && selected && globallyActive` derivation.
 */
export function ActiveTabBody(props: ActiveTabBodyProps) {
  const { activeTab, epicId, groupId, tabId } = props;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const role = useEpicPermissionRole();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const liveArtifact = useEpicArtifact(activeTab.id);
  // Per-tab membership selectors: each tab only re-renders when its own
  // entry flips, not when any other tab is marked/unmarked.
  const isSelfDeleted = useEpicCanvasStore((s) =>
    s.selfDeletedArtifactIds.has(activeTab.id),
  );
  const isPendingCreate = useEpicCanvasStore((s) =>
    s.pendingCreateArtifactIds.has(activeTab.id),
  );
  // Terminals, git-diff tiles, the PR detail/diff pair, workspace files, output
  // windows, the comm graph, and blank tabs are renderer-only - no cloud-backed
  // projection, so a lookup miss isn't deletion. (A blank tab's content id is a
  // throwaway uuid; the comm graph's is derived from the epic id; an output
  // window's is a managed-command id, which the epic doc never carries at all -
  // its own stream reports the command's death instead. Without this guard the
  // artifact lookup would miss and wrongly mark them deleted.)
  const isRemoteDeleted =
    activeTab.type === "terminal" ||
    isDiffTileRef(activeTab) ||
    isPrDetailTileRef(activeTab) ||
    isPrDiffTileRef(activeTab) ||
    isBlankTileRef(activeTab) ||
    isManagedCommandOutputTileRef(activeTab) ||
    isCommGraphTileRef(activeTab) ||
    activeTab.type === WORKSPACE_FILE_TAB_KIND
      ? false
      : computeIsRemoteDeleted({
          snapshotLoaded,
          leafArtifact: activeTab,
          liveArtifact,
          isSelfDeleted,
          isPendingCreate,
        });
  const isActive = role !== null && props.selected && props.globallyActive;

  // Reports the SAME isRemoteDeleted value this render already uses for the
  // inline DeletedArtifactBody branch below, into the outside-React registry
  // `tile-surface-membership.ts`'s eligibility check reads - see
  // `remote-deleted-chat-registry.ts`. Chat-only: membership only ever tracks
  // chat instanceIds. Unregisters (reports false) on unmount so a closed
  // tab's entry never lingers.
  //
  // A LAYOUT effect, not a passive one (design-review slice-4 F2 residual):
  // this render already commits to the inline `DeletedArtifactBody` branch
  // below for a remote-deleted chat, but that alone doesn't remove the
  // hosted owner - `tile-surface-membership.ts`, `tile-surface-environment-
  // registry.ts`, and `StableTileSurfaceHost`'s record all only react to
  // THIS report. Every link in that reaction chain is synchronous
  // (`remote-deleted-chat-registry.ts`'s listener notification and
  // `tile-surface-membership.ts`'s `recomputeMembership` both call their
  // listeners in the same synchronous call stack this layout effect runs
  // in; the `useSyncExternalStore` reads in `StableTileSurfaceHost`/
  // `TileSurfaceRecord` force a synchronous re-render on notification by
  // React's own tearing-avoidance contract). That forced re-render is its
  // own, LATER React commit - not interleaved into this commit's own layout-
  // effect list - but it is still fully synchronous and still resolves
  // strictly before the browser paints, so reporting from a layout effect
  // still closes the gap: the hosted record is gone and membership has
  // dropped the instance before anything is painted, never visible
  // alongside the inline deleted body (verified with a raw non-`act()`
  // macrotask probe - a same-commit sibling layout-effect probe cannot
  // observe this because it necessarily samples before that later commit).
  useLayoutEffect(() => {
    if (activeTab.type !== "chat") return undefined;
    reportChatRemoteDeletionState(activeTab.instanceId, isRemoteDeleted);
    return () => {
      reportChatRemoteDeletionState(activeTab.instanceId, false);
    };
  }, [activeTab.type, activeTab.instanceId, isRemoteDeleted]);

  if (isRemoteDeleted) {
    return (
      <DeletedArtifactBody
        onClose={() => {
          navigateNested(epicId, tabId, () =>
            prepareCloseCanvasTabFocusTarget(
              tabId,
              groupId,
              activeTab.instanceId,
            ),
          );
        }}
      />
    );
  }

  if (surfaceOwnerFor({ node: activeTab, isRemoteDeleted }) === "hosted") {
    return (
      <TileSurfaceSlot
        node={activeTab}
        epicId={epicId}
        paneId={groupId}
        viewTabId={tabId}
        tabSelected={props.selected}
        canvasPaneActive={props.globallyActive}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <EpicNodeTile
        node={activeTab}
        viewTabId={tabId}
        tileId={groupId}
        epicId={epicId}
        isActive={isActive}
      />
    </div>
  );
}

interface DeletedArtifactBodyProps {
  readonly onClose: () => void;
}

function DeletedArtifactBody(props: DeletedArtifactBodyProps): ReactNode {
  return (
    <div
      data-testid="deleted-node-body"
      className="flex h-full min-h-0 w-full items-center justify-center"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-ui-sm text-muted-foreground">
          This node was deleted.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClose}
          data-testid="deleted-node-close"
        >
          Close
        </Button>
      </div>
    </div>
  );
}

interface ComputeIsRemoteDeletedArgs {
  readonly snapshotLoaded: boolean;
  readonly leafArtifact: EpicNodeRef | null;
  readonly liveArtifact:
    EpicArtifactProjection | EpicChatProjection | EpicTuiAgentProjection | null;
  readonly isSelfDeleted: boolean;
  /**
   * Symmetric counterpart to `isSelfDeleted`: the local user just initiated
   * creation. The projection miss is "creation in flight", not deletion.
   */
  readonly isPendingCreate: boolean;
}

function computeIsRemoteDeleted(args: ComputeIsRemoteDeletedArgs): boolean {
  const {
    snapshotLoaded,
    leafArtifact,
    liveArtifact,
    isSelfDeleted,
    isPendingCreate,
  } = args;
  if (!snapshotLoaded) return false;
  if (leafArtifact === null) return false;
  if (liveArtifact !== null) return false;
  if (isSelfDeleted) return false;
  if (isPendingCreate) return false;
  return true;
}
