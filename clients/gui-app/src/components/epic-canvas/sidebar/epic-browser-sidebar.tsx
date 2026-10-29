import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { BrowserTabDriver } from "@traycer/protocol/host/browser/contracts";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  BROWSERS_PANEL_ID,
  BrowserSearchHeaderInput,
} from "./epic-browser-sidebar-header";
import { BrowserTabRow } from "./epic-browser-sidebar-row";
import { BrowserDeviceGroup } from "./browser-device-group";
import { BrowserListFeedback } from "./browser-list-feedback";
import { useBrowserListModel } from "./use-browser-list-model";
import {
  useBrowserTabRowLabels,
  type BrowserSidebarSession,
  type BrowserSidebarTab,
} from "./use-browser-tab-rows";
import { useBrowserListTabClose } from "@/components/epic-canvas/sidebar/use-browser-list-tab-close";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import {
  usePanelHeaderSearchQuery,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
  useVisibleSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { revealSidebarNode } from "./epic-sidebar-tree-shared";

export { BrowsersPanelActions } from "./epic-browser-sidebar-header";

export function BrowsersPanelBody(props: LeftPanelSlotProps) {
  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <BrowsersPanelList {...props} />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

function BrowsersPanelList(props: LeftPanelSlotProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const revealRequest = useSidebarNodeRevealRequest(props.tabId);
  const visibleReveal = useVisibleSidebarNodeRevealRequest(props.tabId);
  const searchQuery = usePanelHeaderSearchQuery(props.tabId, BROWSERS_PANEL_ID);
  const clearSearch = usePanelHeaderSearchStore(
    (state) => state.setSearchQuery,
  );
  const model = useBrowserListModel(
    props.epicId,
    searchQuery,
    visibleReveal?.nodeId ?? null,
  );
  const chats = useEpicChatRecords();
  const chatById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );
  const { secondaryByKey, duplicateTitles } = useBrowserTabRowLabels(
    model.rows,
  );
  const { openTile } = useEpicTileNavigation();
  const closeTab = useBrowserListTabClose(props.epicId);

  useLayoutEffect(() => {
    if (revealRequest === null || listRef.current === null) return;
    if (
      revealSidebarNode(
        listRef.current,
        revealRequest.nodeId,
        revealRequest.nonce,
      )
    )
      clearSidebarNodeRevealRequest(props.tabId, revealRequest.nonce);
  }, [model.groups, props.tabId, revealRequest]);

  const openTab = useCallback(
    (session: BrowserSidebarSession, tab: BrowserSidebarTab) => {
      const tile = makeBrowserSessionTileRef({
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      });
      openTile(tileIntent(tile, { tabId: props.tabId }, "single", "direct_ui"));
    },
    [openTile, props.tabId],
  );
  const openTabPermanently = useCallback(
    (session: BrowserSidebarSession, tab: BrowserSidebarTab) => {
      const tile = makeBrowserSessionTileRef({
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      });
      openTile(
        tileIntent(tile, { tabId: props.tabId }, "explicit", "direct_ui"),
      );
    },
    [openTile, props.tabId],
  );
  const openDrivingChat = useCallback(
    (driver: BrowserTabDriver, hostId: string) => {
      const chat = chatById.get(driver.chatId);
      if (chat === undefined) return;
      const chatTile = makeOpenableNodeRef({
        id: chat.id,
        instanceId: crypto.randomUUID(),
        type: "chat",
        name: chat.title,
        hostId,
      });
      openTile(
        tileIntent(
          chatTile,
          { tabId: props.tabId },
          // No double-click gesture exists on these rows, so `single` would
          // leave nothing that pins the tile: the next preview would evict it.
          "explicit",
          "direct_ui",
        ),
      );
    },
    [chatById, openTile, props.tabId],
  );

  return (
    <>
      <BrowserSearchHeaderInput
        tabId={props.tabId}
        resultCount={model.matches.length}
      />
      <BrowserListFeedback
        model={model}
        epicId={props.epicId}
        tabId={props.tabId}
        query={searchQuery}
        onClearSearch={() => clearSearch(props.tabId, BROWSERS_PANEL_ID, "")}
        onOpened={null}
      />
      <div
        ref={listRef}
        className="min-w-0 space-y-1"
        data-testid="epic-browsers-panel-list"
      >
        {model.groups.map((group) => (
          <BrowserDeviceGroup
            key={group.hostId}
            group={group}
            mobile={false}
            onExpandedChange={(hostId, expanded) =>
              model.preferences.setCollapsed(hostId, !expanded)
            }
          >
            <ul
              aria-label={`Browser tabs on ${group.name}`}
              className="space-y-0.5"
            >
              {group.rows.map(({ key, session, tab, identity }) => (
                <BrowserTabRow
                  key={key}
                  epicId={props.epicId}
                  viewTabId={props.tabId}
                  session={session}
                  tab={tab}
                  identity={identity}
                  secondaryLabel={secondaryByKey.get(key) ?? null}
                  chatById={chatById}
                  duplicateTitles={duplicateTitles}
                  unavailable={group.offline}
                  onOpenTab={openTab}
                  onOpenTabPermanently={openTabPermanently}
                  onOpenDrivingChat={openDrivingChat}
                  onCloseTab={(_sessionId, tabId) => closeTab(session, tabId)}
                />
              ))}
            </ul>
          </BrowserDeviceGroup>
        ))}
      </div>
    </>
  );
}
