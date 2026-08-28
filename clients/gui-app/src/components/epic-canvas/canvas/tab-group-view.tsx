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
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";
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
  TILE_KIND_GIT_DIFF,
  TILE_KIND_PUBLISHED_CHAT,
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
      const tab = tabs.find((t) => t.instanceId === tileTabId);
      // The Chats / Artifacts trees light their active row on their own; the
      // workspace file tree cannot - its rows are lazily covered and the
      // panel may be showing another workspace - so it is TOLD which file to
      // show. Written BEFORE the panel switch so a panel that mounts on the
      // switch reads the request on its first render.
      if (tab !== undefined && isWorkspaceFileRef(tab)) {
        requestFileTreeReveal(tabId, {
          hostId: tab.hostId,
          workspacePath: tab.workspacePath,
          filePath: tab.filePath,
        });
      }
      if (
        tab !== undefined &&
        (tab.type === "chat" || tab.type === "terminal-agent")
      ) {
        requestSidebarNodeReveal(tabId, tab.id);
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
  // Keep-alive mounting policy: pinned terminals ∪ LRU(cap 3) of recently
  // active tabs, with the active tab as the LRU head (so at most 3
  // non-terminal bodies are mounted, INCLUDING the active one), ∪ the pane's
  // retained chats; a hidden pane collapses the LRU to active-only
  // (+terminals, +chats). See use-mounted-pane-tabs.ts.
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
                    // Hidden terminals and retained chats conceal via
                    // `visibility` so the concealed body keeps its box - xterm
                    // needs its dimensions, and a chat reflowed at zero width
                    // republishes bogus item sizes. Hidden LRU keep-alives use
                    // `display:none` so concealed heavy bodies cost no layout
                    // or paint.
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

// Mirrors `ChatSessionAccessError`'s code on the host
// (`traycer-host/src/domain/chat/chat-session-manager.ts`) - deliberately
// the SAME code for "this chat does not exist" and "you are not its owner"
// (an enumeration-oracle guard: a non-owner probing chat ids must not be
// able to tell the two apart). Matching on it here does not weaken that -
// both causes get the identical substitution below, exactly as the wire
// already refuses to distinguish them.
const CHAT_SESSION_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

/**
 * CONSISTENCY over ref provenance (user ruling, 2026-08-09): a live chat tab
 * whose bound host is unreachable renders what a fresh click on its row
 * renders - the published copy, locked - instead of a dead dial wearing a
 * live tab's face. The ref itself is untouched (bind-for-life protects DATA
 * identity: we never show a different host's chat under this tab); only the
 * SURFACE follows reachability, and it flips back to live the moment the
 * owner returns. The copy ref binds a LIVE reading host - serving a cloud
 * read through the dead bound host would just be the same dial with extra
 * steps - so it needs a resolvable active host that differs from the bound
 * one, and an owner user id derivable from the projection.
 *
 * ## Extended for a REACHABLE owner with a confirmed-absent chat (ticket 35)
 *
 * The bound host can be perfectly reachable and still have nothing to serve
 * for this specific chat - a leased "machine" identity that never adopted
 * this chat's rows, or any other case where `chat.subscribe` genuinely
 * terminates `CHAT_NOT_VISIBLE`. There is deliberately NO separate
 * pre-check RPC for this (an existence probe distinct from the wire's own
 * collapsed signal would reopen the enumeration oracle noted above) - the
 * only source of truth is `chat.subscribe`'s own terminate, already
 * surfaced as `fatalClose` on the session store `chat-tile.tsx` creates via
 * `useChatSessionHandle`. `useExistingChatSessionFatalClose` peeks that
 * SAME session from here without acquiring a second one, so this is a
 * two-phase decision (render live first, substitute once the terminate
 * lands) rather than the reachability arm's upfront one - `chat-tile.tsx`
 * must attempt the open before this can possibly fire.
 *
 * ## Extended AGAIN for a SAME-host chat with no local record (ticket 36)
 *
 * Ticket 35's `confirmedAbsent` needs `chat-tile.tsx` to have already
 * attempted `chat.subscribe` - and at the time this arm was written
 * `chat-tile.tsx`'s own `enabled` gate was the doc record alone, so it never
 * even TRIED for a same-host tab with no local record and `fatalClose` never
 * fired for this case (ticket 49 changed that; see the section below).
 * Without this arm the tile fell through to
 * `computeIsRemoteDeleted`'s reap instead (a silent no-open, ticket 36's
 * bug report). `cloudChatRecord` reads the SAME already-fetched
 * `useCloudChatList` data `use-epic-route-synchronization.ts`'s reap
 * exemption reads (`epic.listCloudChats`'s host-side filter already
 * excludes anything this host's registry has tombstoned, so cloud presence
 * alone is trustworthy here - no local-tombstone check needed client-side).
 * `ownerUserId` comes off the cloud row instead of `liveArtifact` for this
 * arm specifically, since a chat this arm targets by definition has no
 * local projection to read it from.
 *
 * ## NARROWED for a REACHABLE same-host owner (ticket 49)
 *
 * Ticket 36's arm above rested on "a same-host chat with no epic-doc record
 * is a chat this host genuinely does not hold". That equivalence was already
 * false when it landed: chat creation stopped projecting into the epic doc
 * (`chat-registry-writer.ts`, ticket 19) and `ChatDocEntrySweep` deletes
 * every entry whose publication it has proven (ticket 20), so "no doc
 * record" became the ORDINARY steady state of a healthy, owned,
 * fully-present chat. The renderer's record set is a shrinking set of
 * pre-upgrade entries converging on empty, and every chat the sweep had
 * migrated opened as the locked published copy on its own connected host -
 * no `chat.subscribe` ever dispatched, tree position and
 * rename/archive/delete affordances gone (live-found on staging
 * 2026-08-11).
 *
 * So cloud-known-and-record-less no longer substitutes on its own. It is now
 * the `ownerUserId` SOURCE for a same-host substitution, and the proof that
 * there IS a published copy to substitute with - never the trigger. The
 * triggers are the same two facts the cross-host arms already use:
 *
 * - the owner host is unreachable (nothing can be dialed), or
 * - `chat.subscribe` itself terminated `CHAT_NOT_VISIBLE`.
 *
 * The second is the honest absence detector for a REACHABLE owner, and it is
 * the only one there can be: there is deliberately no existence-probe RPC
 * (the enumeration-oracle guard noted above), so absence is something the
 * host SAYS, never something the client infers from its own missing
 * projection. That is why this fix has a second half in `chat-tile.tsx` -
 * its record gate has to let a cloud-known chat OPEN before any terminate
 * can be observed from here.
 *
 * The two shapes this narrowing deliberately leaves alone: a same-host chat
 * with no cloud row at all (nothing anywhere attests to it, so
 * `computeIsRemoteDeleted` still reaps it), and a same-host chat that HAS a
 * local record and still terminates `CHAT_NOT_VISIBLE` (a published copy to
 * swap it for is exactly what it does not have, so it keeps its live
 * generic-error surface).
 */
/**
 * The revoked banner's clone handler. Module-level so it is reference-stable,
 * and a no-op because that banner declares `offersClone: false` and therefore
 * never renders a control that could call it - the prop exists only because
 * `ChatDeadTileBanner` is shared with the three reasons that DO offer it.
 */
const noopClone = (): void => undefined;

interface ChatFallbackDecision {
  readonly substitute: boolean;
  readonly reason: ChatDeadTileBannerReason;
  readonly ownerUserId: string | null;
}

/**
 * The three substitution causes, resolved in one place and kept OUT of the
 * hook body below on purpose - `usePublishedChatFallbackRef` mixes React
 * hook calls with this decision, and folding the branching in with them is
 * what pushed its own complexity over this repo's lint ceiling. Pure
 * function, easy to reason about (and test) independently of the hooks that
 * feed it.
 */
function resolveChatFallbackDecision(args: {
  readonly isChat: boolean;
  readonly isSameHost: boolean;
  readonly hostUnreachable: boolean;
  readonly unavailability: HostUnavailability | null;
  readonly confirmedAbsent: boolean;
  readonly cloudChatOwnerUserId: string | null;
  readonly liveArtifactOwnerUserId: string | null;
}): ChatFallbackDecision {
  // A published copy exists for this chat and it is the viewer's own (the
  // caller only resolves this row for a same-host chat with no local record -
  // see `wantsCloudChatFallback`). Necessary for a same-host substitution,
  // never sufficient: post-ticket-19/20 this is the steady state of a healthy
  // chat, not evidence of absence (ticket 49).
  const sameHostCloudCopyAvailable = args.cloudChatOwnerUserId !== null;
  // The two honest absence causes, shared by both host arms. `hostUnreachable`
  // is upfront; `confirmedAbsent` is the host's own `CHAT_NOT_VISIBLE`
  // terminate, which lands only after `chat-tile.tsx` has attempted the open.
  const absent = args.hostUnreachable || args.confirmedAbsent;
  // Same-host needs the copy in hand as well - a same-host chat with no cloud
  // fallback is a genuine local error, not a substitutable one (ticket 35's
  // rule, preserved). Cross-host keeps deriving its owner from the projection
  // or the ref, so it does not need the row.
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
 *
 * The banner says three different things (see `ChatDeadTileBannerReason`) and
 * picking the wrong one is how this surface came to name a healthy local
 * machine as unreachable on 2026-08-11.
 *
 * Unreachability outranks a `CHAT_NOT_VISIBLE` terminate on purpose: the
 * terminate is a fact from an earlier moment, reachability is the state right
 * now, and a reader whose host has since gone away needs the host sentence,
 * not a report about a subscribe that is no longer possible. Below it the
 * split is simply whose machine spoke - a host that answers "not here" about
 * ITSELF is reporting a missing chat, not a device the reader has to go wake.
 */
function deadTileBannerReason(input: {
  readonly hostUnreachable: boolean;
  readonly unavailability: HostUnavailability | null;
  readonly isSameHost: boolean;
}): ChatDeadTileBannerReason {
  if (input.hostUnreachable) {
    // The hook's reason, not a constant - collapsing every unreachable
    // result to `host-offline` is how a `plan-restricted` host (running
    // fine, just with no remote route on this account's plan) got reported
    // to its owner as being off. Same fix as `chat-tile.tsx`'s live-render
    // path.
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
   * Narrowed to the published-chat shape (the only ref this hook ever
   * builds) so the substitution mount can thread `ownerUserId` - the owner
   * the OPENING ROW resolved - into the banner instead of leaving the
   * banner's container to re-derive it from a second cloud lookup that can
   * fail independently (cold-review finding).
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
  // The tab's OWN bound host (`activeTab.hostId`), which is exactly the host
  // `chat-tile.tsx` opened the session under - peeking any other host's
  // session for this chat id would read a different machine's terminate.
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
  // The Epic SESSION's client - the same one the sidebar's tree fetches this
  // list on, so the TanStack cache is shared rather than split by host, and
  // the one host known to be serving this canvas.
  const sessionHostClient = useEpicSessionHostClient();
  const cloudChats = useCloudChatList({
    client: sessionHostClient,
    taskId: epicId,
    enabled: wantsCloudChatFallback,
  });
  const cloudChatRecord = wantsCloudChatFallback
    ? (cloudChats.data?.chats.find(
        // The OWNER is half the identity, not a refinement of the id: `chatId`
        // is host-minted and the list deliberately carries every task-visible
        // row including collaborators'. This arm targets a same-host local chat
        // ref, which is the viewer's own by construction, so an id-only match
        // could pick a collaborator's row on list order alone and open their
        // transcript as this tab's fallback.
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
  // The SERVING host is chosen once, when this fallback first opens, and then
  // held. `activeHostId` has to stay reactive for the decision above it (the
  // record gate and `isSameHost` are questions about the projection this render
  // is reading), but it must not reach the REF: the ref's `hostId` is what
  // `renderTile` binds its `TabHostProvider` to, so following the app-wide host
  // would move an already-open copy's reads onto a different client mid-session -
  // a readable tab turning loading, failed or unsupported with nothing about the
  // tab or the chat having changed. Same rule the sidebar row follows by
  // capturing its reading host at click time, and the one the published tile's
  // own doc comment states.
  //
  // Captured once, when this tab body mounts - the same `useState` snapshot
  // `chat-tile.tsx` takes for its own cross-host decision, and for the same
  // reason: an app-wide host swap must not reach a tab that is already open. A
  // swap does not remount this body, so the snapshot holds for the tab's life;
  // activating the tab again is what re-takes it.
  //
  // A null snapshot (the binding was still resolving) yields no fallback for
  // that mount, and the tab keeps the dead-tile banner and its clone CTA. That is
  // the same "null is ignorance, not evidence" tradeoff `isCrossHostOpen`
  // documents, and reopening the tab recovers it - where a latch that filled
  // itself later would need either a render-time ref write or a
  // set-state-in-effect, both unsafe under concurrent rendering and both refused
  // by `react-hooks/*` here.
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

/**
 * WHY this tab's chat record left, when the push stream said so.
 *
 * The record table alone reports only that a row is GONE, and the two
 * departures need opposite surfaces: a DELETED chat is a node that no longer
 * exists (the deleted-node body, with its Close), a REVOKED one still exists
 * and is simply not this viewer's to read any more.
 *
 * Non-chat tabs answer `null` without the store ever being asked about them.
 * Extracted from `ActiveTabBody` rather than inlined for the same reason
 * `resolveChatFallbackDecision` is - that function mixes hook calls with
 * branching and sits one conditional under this repo's lint ceiling.
 */
function useChatTabRetraction(
  activeTab: EpicCanvasTileRef,
): ChatRecordRemovalReason | null {
  return useEpicChatRetraction(activeTab.type === "chat" ? activeTab.id : null);
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
  const chatRecordListAuthoritative = useEpicChatRecordListAuthoritative();
  const liveArtifact = useEpicArtifact(activeTab.id);
  // The projection feeding `liveArtifact` is served by the EPIC SESSION's
  // host - NOT the app-wide active one, which is what this comment used to
  // say and what the read below used to be. `EpicSessionProvider` keeps the
  // previous handle registered and rendered while a re-point establishes and
  // after one fails, so during an A→B re-point the records are still A's
  // while the app-wide pointer already says B. Judging refs against B then
  // inverted the record gate: A-bound tabs read as cross-host (exempt) and
  // B-bound tabs were policed against a projection that could not contain
  // them - reported remote-deleted. Cross-host CHAT refs stay exempt (see
  // `computeIsRemoteDeleted`); "same host" means the SESSION's. This is canvas
  // machinery at epic-view altitude, not a chat tab - hence the canvas host,
  // not `useTabHostId()`.
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
  // Per-tab membership selectors: each tab only re-renders when its own
  // entry flips, not when any other tab is marked/unmarked.
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
  // Terminals, browser surfaces, diff/PR tiles, workspace files, output
  // windows, the comm graph, and blank tabs are renderer-only, so a cloud
  // artifact lookup miss is not deletion. A blank id is throwaway, the comm
  // graph id is epic-derived, and an output id belongs to a managed command;
  // each surface owns its own lifecycle instead.
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
    // The published-copy fallback is folded in because the registry's real
    // contract is "ActiveTabBody has taken this chat inline - drop the hosted
    // surface", and the fallback branch below is a second inline takeover.
    // Without it, membership keeps the instance, the environment registry
    // ("removal only by membership") retains a stale visible/anchored
    // snapshot from the unmounted slot, and the hosted live body paints over
    // the copy - the exact two-owners drift design-review slice-4 finding 2
    // exists to prevent. Reported through the deletion registry rather than a
    // parallel one so membership has ONE inline-takeover input.
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

  // Ahead of the published-copy substitution on purpose: that branch's whole
  // premise is that there is a readable copy to show under the banner, and a
  // revocation is precisely the loss of permission to read one. Rendering the
  // banner ALONE is the honest end state - no transcript, and (per
  // `offersClone`) no clone offer that would fail on the first read.
  if (isRetractedAsRevoked) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <ChatDeadTileBanner
          hostLabel={ownerHostLabel}
          reason="chat-no-longer-shared"
          // Both moot for this reason: the revoked copy never varies by owner
          // and declares `offersClone: false`, so neither flag can render
          // anything. Passed as the do-nothing pair, like `noopClone`.
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
          // The owner the opening row already resolved (the fallback ref is
          // only built once one exists) - threading it means the banner's
          // ownership verdict cannot disagree with the copy rendered under
          // it, and does not depend on the container's own cloud lookup.
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
  /**
   * Same-host counterpart of the cross-host exemption below (chat-sync-v2
   * ticket 36): true when this SAME-host chat has no local record but is
   * still known to `epic.listCloudChats` (whose host-side filter already
   * excludes anything this host's own registry has tombstoned - see
   * `usePublishedChatFallbackRef`, which computes this alongside the
   * substitution ref so the two never disagree).
   */
  readonly isCloudKnown: boolean;
  /** Whether cloud-list absence is an answered fact, not pending/error. */
  readonly cloudListAuthorizesChatAbsence: boolean;
  /** Whether the local record list has answered for this epic session. */
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
  // POSITIVE evidence, so it outranks every exemption below - each of those
  // exists because a missing projection is not proof of deletion, and this is
  // the one signal that IS proof. In particular it outranks the cross-host
  // exemption (a chat on another host is invisible to this projection, but a
  // delete the host announced is not an inference) and the cloud-known
  // exemption (a published copy outliving the chat is exactly the ghost row
  // the record plane's tombstones exist to retract).
  if (leafArtifact.type === "chat" && retractedAsDeleted) return true;
  // Until the app-wide host binding and both record lists answer, absence
  // cannot be classified. A disabled or failed query is not evidence that the
  // bound chat disappeared.
  if (leafArtifact.type === "chat" && !chatAbsenceIsAuthoritative(args)) {
    return false;
  }
  // A CHAT ref bound to another host is invisible to this device's
  // projection by construction - chat records are host-authoritative, so a
  // cross-host live tab (reachable owner opened from the unified sidebar)
  // must not read as "remotely deleted". Its record lives in the OWNER
  // host's registry, which this projection cannot see. Chat-only: artifact
  // and terminal-agent records are doc-shared, so their projection miss
  // still means deleted regardless of the ref's bound host. Mirrors
  // `isTileRefRecordLive`'s exemption - the two record-liveness gates must
  // agree or a click opens a tile the surface refuses to mount.
  if (
    leafArtifact.type === "chat" &&
    projectionHostId !== null &&
    leafArtifact.hostId !== projectionHostId
  ) {
    return false;
  }
  if (liveArtifact !== null) return false;
  if (isSelfDeleted) return false;
  if (isPendingCreate) return false;
  if (leafArtifact.type === "chat" && isCloudKnown) return false;
  return true;
}
