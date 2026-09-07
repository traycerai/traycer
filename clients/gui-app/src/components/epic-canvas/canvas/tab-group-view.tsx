import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import { ChatDeadTileBannerContainer } from "@/components/epic-canvas/renderers/chat-tile";
import {
  ChatDeadTileBanner,
  type ChatDeadTileBannerReason,
} from "@/components/epic-canvas/renderers/dead-tile-banner";
import { useExistingChatSessionFatalClose } from "@/lib/registries/chat-session-registry";
import {
  cloudChatListAuthorizesRecordSweep,
  useCloudChatList,
} from "@/hooks/chats/use-cloud-chat-queries";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";
import {
  PaneActivationFocusIntentContext,
  registerHostedPaneActivationClaim,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";
import { cn } from "@/lib/utils";
import {
  epicTerminalUiIdentityKey,
  hasTerminalPendingCreate,
} from "@/lib/terminals/pending-create-identity";
import {
  useEpicCanvasStore,
  useIsActivePane,
  usePaneTabRefs,
} from "@/stores/epics/canvas/store";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import {
  useEpicArtifact,
  useEpicChatRecordListAuthoritative,
  useEpicChatRetraction,
  useEpicPermissionRole,
  useEpicSnapshotLoaded,
  type EpicArtifactProjection,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
} from "@/lib/epic-selectors";
import { EpicNodeTile } from "@/components/epic-canvas/renderers/epic-node-tile";
import { PaneDropZone } from "@/components/epic-canvas/dnd/pane-drop-zone";
import {
  concealsWithoutCollapsing,
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
  PublishedChatTileRef,
  SplitDirection,
  TilePane,
} from "@/stores/epics/canvas/types";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";
import { isHostAuthoritativeRef } from "@/stores/epics/canvas/canvas-selectors";
import { isTileRefRecordBacked } from "@/stores/epics/canvas/tile-schema";
import { isWorkspaceFileRef } from "@/stores/epics/canvas/types";
import { requestFileTreeReveal } from "@/stores/file-tree/file-tree-reveal-store";
import { requestSidebarNodeReveal } from "@/stores/epics/sidebar-node-reveal-store";
import { resolveActivePaneTab } from "@/stores/epics/canvas/tile-tree";
import { surfaceOwnerFor } from "@/components/epic-canvas/surface-host/surface-owner";
import { TileSurfaceSlot } from "@/components/epic-canvas/surface-host/tile-surface-slot";
import { reportChatRemoteDeletionState } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import { HOSTED_TILE_RECORD_SELECTOR } from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import {
  TILE_KIND_BROWSER_SESSION,
  TILE_KIND_GIT_DIFF,
  TILE_KIND_PUBLISHED_CHAT,
  TILE_KIND_PR_DETAIL,
  TILE_KIND_PR_DIFF,
  TILE_KIND_SNAPSHOT_DIFF,
} from "@/stores/epics/canvas/tile-kinds";
import {
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { useRenameCanvasTab } from "@/components/epic-canvas/canvas/use-rename-canvas-tab";
import {
  useLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { isEditableRole } from "@/lib/epic-permissions";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { prDetailTileId } from "@/lib/pr/pr-detail-tile";

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
  // A published chat is a chat: its row lives in the Chats tree, so "Reveal in
  // sidebar" has to open that panel and not fall through to the default.
  if (
    tabType === "chat" ||
    tabType === "terminal-agent" ||
    tabType === TILE_KIND_PUBLISHED_CHAT
  ) {
    return "chats";
  }
  if (tabType === "terminal") return "terminals";
  if (tabType === TILE_KIND_GIT_DIFF) return "git-diff";
  if (tabType === TILE_KIND_SNAPSHOT_DIFF) return "chats";
  if (tabType === WORKSPACE_FILE_TAB_KIND) return "file-tree";
  if (tabType === TILE_KIND_PR_DETAIL) return "pull-requests";
  if (tabType === TILE_KIND_PR_DIFF) return "pull-requests";
  if (tabType === TILE_KIND_BROWSER_SESSION) return "browsers";
  return "artifacts";
}

function sidebarRevealNodeIdForTab(tab: EpicCanvasTileRef): string | null {
  if (isTileRefRecordBacked(tab)) return tab.id;
  switch (tab.type) {
    case TILE_KIND_BROWSER_SESSION:
      return tab.id;
    case "terminal":
      return epicTerminalUiIdentityKey("session", tab.hostId, tab.id);
    case TILE_KIND_PUBLISHED_CHAT:
      return tab.chatId;
    case TILE_KIND_SNAPSHOT_DIFF:
      return tab.diff.chatId;
    case TILE_KIND_PR_DETAIL:
    case TILE_KIND_PR_DIFF:
      return prDetailTileId({
        hostId: tab.hostId,
        githubHost: tab.githubHost,
        owner: tab.owner,
        repo: tab.repo,
        prNumber: tab.prNumber,
      });
    case TILE_KIND_GIT_DIFF:
      return tab.diff.kind === "file" ? tab.id : null;
    default:
      return null;
  }
}

/** Drops on body edges split the pane; drops on body center add the tab to this pane. */
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

  // Per-pane boolean (not the raw `activePaneId`) so switching the active pane re-renders only the two panes whose active state flips, not all of them.
  const globallyActive = useIsActivePane(tabId, pane.id);
  // Whether the canvas root is a group - i.e. more than one pane exists.
  const canvasIsSplit = useEpicCanvasStore(
    (s) => s.canvasByTabId[tabId]?.root?.kind === "group",
  );
  // Hide the strip only for a lone, empty root pane - there is nothing to act on.
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
    () =>
      registerHostedPaneActivationClaim(tabId, pane.id, {
        claimFocus,
        claimPointerDown,
      }),
    [claimFocus, claimPointerDown, pane.id, tabId],
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
    // Hosted records are physical siblings of the pane root, so its React focus capture handler cannot see them.
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
      const tab = tabs.find((t) => t.instanceId === tileTabId);
      // Written BEFORE the panel switch so a panel that mounts on the switch reads the request on its first render.
      if (tab !== undefined && isWorkspaceFileRef(tab)) {
        requestFileTreeReveal(tabId, {
          hostId: tab.hostId,
          workspacePath: tab.workspacePath,
          filePath: tab.filePath,
        });
      }
      const sidebarNodeId =
        tab === undefined ? null : sidebarRevealNodeIdForTab(tab);
      if (sidebarNodeId !== null) {
        requestSidebarNodeReveal(tabId, sidebarNodeId);
      }
      if (tab?.type === TILE_KIND_BROWSER_SESSION) {
        useSurfaceHostSelectionStore
          .getState()
          .setSelection(tabSurfaceKey("browsers", tabId), tab.hostId);
      }
      setActivePanelIdAndExpand(tabId, panelIdForTabType(tab?.type));
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
  // Keep-alive mounting policy: pinned terminals ∪ LRU(cap 3) of recently active tabs, with the active tab as the LRU head (so at most 3 non-terminal bodies are mounted, INCLUDING the active one), ∪ the pane's retained chats; a hidden pane collapses the LRU to active-only (+terminals, +chats).
  // See use-mounted-pane-tabs.ts.
  const paneVisible = usePaneVisible();
  const mountedTabIds = useMountedPaneTabs({
    activeTabId: activeTab?.instanceId ?? null,
    pane,
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
                    // Hidden terminals and retained chats conceal via `visibility` so the concealed body keeps its box - xterm needs its dimensions, and a chat reflowed at zero width republishes bogus item sizes.
                    // Hidden LRU keep-alives use `display:none` so concealed heavy bodies cost no layout or paint.
                    const keepsBox = concealsWithoutCollapsing(tab);
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
                            keepsBox &&
                            "invisible pointer-events-none",
                          !selected && !keepsBox && "hidden",
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

// Same host code for missing and not-owner; both substitute identically so a probe cannot tell them apart.
const CHAT_SESSION_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

/**
 * Unreachable or CHAT_NOT_VISIBLE live chats paint the published locked copy; the tab's bound hostId stays.
 * Absence is only the subscribe terminate - no existence-probe RPC (enumeration oracle).
 */
/** Required by ChatDeadTileBanner; this banner never offers clone. */
const noopClone = (): void => undefined;

interface ChatFallbackDecision {
  readonly substitute: boolean;
  readonly reason: ChatDeadTileBannerReason;
  readonly ownerUserId: string | null;
}

/** Kept out of the hook body so hook calls and this branch do not share a complexity budget. */
function resolveChatFallbackDecision(args: {
  readonly isChat: boolean;
  readonly isSameHost: boolean;
  readonly hostUnreachable: boolean;
  readonly unavailability: HostUnavailability | null;
  readonly confirmedAbsent: boolean;
  readonly cloudChatOwnerUserId: string | null;
  readonly liveArtifactOwnerUserId: string | null;
}): ChatFallbackDecision {
  // A published copy exists for this chat and it is the viewer's own (the caller only resolves this row for a same-host chat with no local record - see `wantsCloudChatFallback`).
  const sameHostCloudCopyAvailable = args.cloudChatOwnerUserId !== null;
  // `hostUnreachable` is upfront; `confirmedAbsent` is the host's own `CHAT_NOT_VISIBLE` terminate, which lands only after `chat-tile.tsx` has attempted the open.
  const absent = args.hostUnreachable || args.confirmedAbsent;
  // Cross-host keeps deriving its owner from the projection or the ref, so it does not need the row.
  const sameHostFallback =
    args.isSameHost && sameHostCloudCopyAvailable && absent;
  const crossHostFallback = !args.isSameHost && absent;
  const substitute = args.isChat && (crossHostFallback || sameHostFallback);
  const reason = deadTileBannerReason({
    hostUnreachable: args.hostUnreachable,
    unavailability: args.unavailability,
    isSameHost: args.isSameHost,
  });
  const ownerUserId = args.liveArtifactOwnerUserId ?? args.cloudChatOwnerUserId;
  return { substitute, reason, ownerUserId };
}

/**
 * WHICH of the two triggers above fired, and whose host answered.
 * Unreachability outranks a `CHAT_NOT_VISIBLE` terminate on purpose: the terminate is a fact from an earlier moment, reachability is the state right now, and a reader whose host has since gone away needs the host sentence, not a report about a subscribe that is no longer possible.
 */
function deadTileBannerReason(input: {
  readonly hostUnreachable: boolean;
  readonly unavailability: HostUnavailability | null;
  readonly isSameHost: boolean;
}): ChatDeadTileBannerReason {
  if (input.hostUnreachable) {
    // The hook's reason, not a constant - collapsing every unreachable result to `host-offline` is how a `plan-restricted` host (running fine, just with no remote route on this account's plan) got reported to its owner as being off.
    // Same fix as `chat-tile.tsx`'s live-render path.
    return input.unavailability === "plan-restricted"
      ? "host-plan-restricted"
      : "host-offline";
  }
  return input.isSameHost ? "chat-not-on-this-host" : "chat-not-visible";
}

function usePublishedChatFallbackRef(args: {
  readonly activeTab: EpicCanvasTileRef;
  readonly epicId: string;
  readonly liveArtifact:
    | EpicArtifactProjection
    | EpicChatProjection
    | EpicTuiAgentProjection
    | null;
  readonly activeHostId: string | null;
}): {
  /**
   * Narrowed to the published-chat shape (the only ref this hook ever builds) so the substitution mount can thread `ownerUserId` - the owner the OPENING ROW resolved - into the banner instead of leaving the banner's container to re-derive it from a second cloud lookup that can fail independently (cold-review finding).
   */
  readonly fallbackRef: PublishedChatTileRef | null;
  readonly ownerHostLabel: string;
  readonly reason: ChatDeadTileBannerReason;
  readonly isCloudKnown: boolean;
  readonly cloudListAuthorizesChatAbsence: boolean;
} {
  const { activeTab, epicId, liveArtifact, activeHostId } = args;
  const isChat = activeTab.type === "chat";
  const isSameHost = activeHostId === activeTab.hostId;
  const reachability = useHostReachability(
    isChat ? activeTab.hostId : UNKNOWN_HOST_PLACEHOLDER,
  );
  // The tab's OWN bound host (`activeTab.hostId`), which is exactly the host `chat-tile.tsx` opened the session under - peeking any other host's session for this chat id would read a different machine's terminate.
  const fatalClose = useExistingChatSessionFatalClose(
    epicId,
    activeTab.id,
    activeTab.hostId,
  );
  const confirmedAbsent =
    isChat &&
    fatalClose !== null &&
    fatalClose.code === CHAT_SESSION_NOT_VISIBLE_CODE;
  const wantsCloudChatFallback = isChat && isSameHost && liveArtifact === null;
  // The Epic SESSION's client - the same one the sidebar's tree fetches this list on, so the TanStack cache is shared rather than split by host, and the one host known to be serving this canvas.
  const sessionHostClient = useEpicSessionHostClient();
  const cloudChats = useCloudChatList({
    client: sessionHostClient,
    taskId: epicId,
    enabled: wantsCloudChatFallback,
  });
  const cloudChatRecord = wantsCloudChatFallback
    ? (cloudChats.data?.chats.find(
        // This arm targets a same-host local chat ref, which is the viewer's own by construction, so an id-only match could pick a collaborator's row on list order alone and open their transcript as this tab's fallback.
        (chat) =>
          chat.identity.chatId === activeTab.id && cloudRowIsViewersOwn(chat),
      ) ?? null)
    : null;
  const liveArtifactOwnerUserId =
    liveArtifact !== null && "userId" in liveArtifact
      ? liveArtifact.userId
      : null;
  const decision = resolveChatFallbackDecision({
    isChat,
    isSameHost,
    hostUnreachable: reachability.status === "unreachable",
    unavailability: reachability.unavailability,
    confirmedAbsent,
    cloudChatOwnerUserId: cloudChatRecord?.identity.ownerUserId ?? null,
    liveArtifactOwnerUserId,
  });
  const { substitute, reason, ownerUserId } = decision;
  // Capture the serving host once on mount; the ref's hostId must not follow app-wide activeHostId mid-session.
  // A null snapshot yields no fallback for that mount - null is ignorance, not evidence.
  const [readingHostId] = useState<string | null>(() => activeHostId);
  const fallbackRef = useMemo(
    () =>
      substitute && ownerUserId !== null && readingHostId !== null
        ? makePublishedChatTileRef({
            taskId: epicId,
            chatId: activeTab.id,
            ownerUserId,
            ownerHostId: activeTab.hostId,
            name: activeTab.name,
            hostId: readingHostId,
          })
        : null,
    [substitute, activeTab, ownerUserId, readingHostId, epicId],
  );
  return {
    fallbackRef,
    ownerHostLabel: reachability.hostLabel,
    reason,
    isCloudKnown: cloudChatRecord !== null,
    cloudListAuthorizesChatAbsence:
      cloudChatListAuthorizesRecordSweep(cloudChats),
  };
}

/** Deleted vs revoked need opposite surfaces; the record table only reports that a row is gone. */
function useChatTabRetraction(
  activeTab: EpicCanvasTileRef,
): ChatRecordRemovalReason | null {
  return useEpicChatRetraction(activeTab.type === "chat" ? activeTab.id : null);
}

export function ActiveTabBody(props: ActiveTabBodyProps) {
  const { activeTab, epicId, groupId, tabId } = props;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const role = useEpicPermissionRole();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const chatRecordListAuthoritative = useEpicChatRecordListAuthoritative();
  const liveArtifact = useEpicArtifact(activeTab.id);
  // Record-gate host is the Epic session host, not the app-wide active host - they diverge during a re-point.
  const activeHostIdForRecordGate = useCanvasHostId();
  const chatRetraction = useChatTabRetraction(activeTab);
  const isRetractedAsRevoked = chatRetraction === "revoked";
  const {
    fallbackRef: publishedFallbackRef,
    ownerHostLabel,
    reason: deadTileBannerReason,
    isCloudKnown,
    cloudListAuthorizesChatAbsence,
  } = usePublishedChatFallbackRef({
    activeTab,
    epicId,
    liveArtifact,
    activeHostId: activeHostIdForRecordGate,
  });
  // Per-tab membership selectors so a tab re-renders only when its own entry flips.
  const isSelfDeleted = useEpicCanvasStore((s) =>
    s.selfDeletedArtifactIds.has(activeTab.id),
  );
  const isPendingCreate = useEpicCanvasStore((s) =>
    activeTab.type === "terminal"
      ? hasTerminalPendingCreate(
          s.pendingCreateTerminalIdentities,
          activeTab.hostId,
          activeTab.id,
        )
      : s.pendingCreateArtifactIds.has(activeTab.id),
  );
  // Renderer-only tiles are not deletion: a cloud artifact lookup miss is not a missing record.
  const isRemoteDeleted = !isTileRefRecordBacked(activeTab)
    ? false
    : computeIsRemoteDeleted({
        snapshotLoaded,
        leafArtifact: activeTab,
        liveArtifact,
        isSelfDeleted,
        isPendingCreate,
        projectionHostId: activeHostIdForRecordGate,
        isCloudKnown,
        cloudListAuthorizesChatAbsence,
        recordListAuthorizesChatAbsence: chatRecordListAuthoritative,
        retractedAsDeleted: chatRetraction === "deleted",
      });
  const isActive = role !== null && props.selected && props.globallyActive;

  // Report this render's isRemoteDeleted and published-copy takeover from a layout effect so membership drops the hosted surface before paint.
  // Unregister false on unmount so a closed tab's entry never lingers.
  useLayoutEffect(() => {
    if (activeTab.type !== "chat") return undefined;
    // Published-copy fallback is also inline takeover; without it membership keeps the instance and the hosted body paints over the copy.
    reportChatRemoteDeletionState(
      activeTab.instanceId,
      isRemoteDeleted || publishedFallbackRef !== null || isRetractedAsRevoked,
    );
    return () => {
      reportChatRemoteDeletionState(activeTab.instanceId, false);
    };
  }, [
    activeTab.type,
    activeTab.instanceId,
    isRemoteDeleted,
    isRetractedAsRevoked,
    publishedFallbackRef,
  ]);

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

  // Ahead of the published-copy substitution on purpose: that branch's whole premise is that there is a readable copy to show under the banner, and a revocation is precisely the loss of permission to read one.
  // Rendering the banner ALONE is the honest end state - no transcript, and (per `offersClone`) no clone offer that would fail on the first read.
  if (isRetractedAsRevoked) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <ChatDeadTileBanner
          hostLabel={ownerHostLabel}
          reason="chat-no-longer-shared"
          // Both moot for this reason: the revoked copy never varies by owner and declares `offersClone: false`, so neither flag can render anything.
          ownedByViewer
          cloneAllowed={false}
          showsPublishedCopy={false}
          onClone={noopClone}
          cloning={false}
          className={undefined}
          testId={`chat-dead-tile-${activeTab.id}`}
        />
      </div>
    );
  }

  if (publishedFallbackRef !== null) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <ChatDeadTileBannerContainer
          epicId={epicId}
          tabId={tabId}
          chatId={activeTab.id}
          sourceHostId={activeTab.hostId}
          hostLabel={ownerHostLabel}
          reason={deadTileBannerReason}
          showsPublishedCopy
          testId={`chat-dead-tile-${activeTab.id}`}
          // The owner the opening row already resolved (the fallback ref is only built once one exists) - threading it means the banner's ownership verdict cannot disagree with the copy rendered under it, and does not depend on the container's own cloud lookup.
          sourceOwnerUserId={publishedFallbackRef.ownerUserId}
        />
        <EpicNodeTile
          node={publishedFallbackRef}
          viewTabId={tabId}
          tileId={groupId}
          epicId={epicId}
          isActive={isActive}
        />
      </div>
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
    | EpicArtifactProjection
    | EpicChatProjection
    | EpicTuiAgentProjection
    | null;
  readonly isSelfDeleted: boolean;
  /**
   * Symmetric counterpart to `isSelfDeleted`: the local user just initiated
   * creation. The projection miss is "creation in flight", not deletion.
   */
  readonly isPendingCreate: boolean;
  /** The host whose projection `liveArtifact` was resolved from. */
  readonly projectionHostId: string | null;
  readonly isCloudKnown: boolean;
  readonly cloudListAuthorizesChatAbsence: boolean;
  readonly recordListAuthorizesChatAbsence: boolean;
  /**
   * The record plane said this chat was DELETED (a `remove` delta whose reason
   * is `deleted`), as opposed to merely absent from a projection.
   */
  readonly retractedAsDeleted: boolean;
}

function chatAbsenceIsAuthoritative(args: ComputeIsRemoteDeletedArgs): boolean {
  return (
    args.projectionHostId !== null &&
    args.cloudListAuthorizesChatAbsence &&
    args.recordListAuthorizesChatAbsence
  );
}

function computeIsRemoteDeleted(args: ComputeIsRemoteDeletedArgs): boolean {
  const {
    snapshotLoaded,
    leafArtifact,
    liveArtifact,
    isSelfDeleted,
    isPendingCreate,
    projectionHostId,
    isCloudKnown,
    retractedAsDeleted,
  } = args;
  if (!snapshotLoaded) return false;
  if (leafArtifact === null) return false;
  // POSITIVE evidence, so it outranks every exemption below - each of those exists because a missing projection is not proof of deletion, and this is the one signal that IS proof.
  // In particular it outranks the cross-host exemption (a chat on another host is invisible to this projection, but a delete the host announced is not an inference) and the cloud-known exemption (a published copy outliving the chat is exactly the ghost row the record plane's tombstones exist to retract).
  if (leafArtifact.type === "chat" && retractedAsDeleted) return true;
  // Until the app-wide host binding and both record lists answer, absence cannot be classified.
  if (leafArtifact.type === "chat" && !chatAbsenceIsAuthoritative(args)) {
    return false;
  }
  // A ref bound to another host is invisible to this device's projection by construction - its record is HOST-AUTHORITATIVE, living in the OWNER host's registry - so a cross-host live tab (a reachable owner's row opened from the unified sidebar) must not read as "remotely deleted".
  // Terminal agents joined that population in the roster's phase 2: this device may now hold a REPLICA of an agent bound to another of the user's machines, and a replica arrives on the record feed's schedule, so any window before the inbox has caught up would otherwise close a tile whose agent is alive on its own host.
  if (
    isHostAuthoritativeRef(leafArtifact) &&
    (projectionHostId === null || leafArtifact.hostId !== projectionHostId)
  ) {
    return false;
  }
  if (liveArtifact !== null) return false;
  if (isSelfDeleted) return false;
  if (isPendingCreate) return false;
  if (leafArtifact.type === "chat" && isCloudKnown) return false;
  return true;
}
