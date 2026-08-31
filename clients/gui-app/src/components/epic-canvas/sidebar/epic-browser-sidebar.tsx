import { Globe2, Plus, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { useCallback, useMemo } from "react";
import type {
  BrowserSessionInfo,
  BrowserTabDriver,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  BROWSERS_PANEL_ID,
  BrowserSearchHeaderInput,
} from "@/components/epic-canvas/sidebar/epic-browser-sidebar-header";
import { BrowserTabRow } from "@/components/epic-canvas/sidebar/epic-browser-sidebar-row";
import { useAddBrowserAction } from "@/components/epic-canvas/sidebar/use-browser-add-action";
import {
  filterBrowserTabRows,
  useBrowserSidebarTabRows,
  useBrowserTabRowLabels,
} from "@/components/epic-canvas/sidebar/use-browser-tab-rows";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { BrowserSessionsHostBoundary } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import { usePanelHeaderSearchQuery } from "@/stores/epics/panel-header-search-store";

/**
 * The browsers panel's header cluster lives in
 * `epic-browser-sidebar-header.tsx`; it is re-exported here because
 * `left-panel-registry` and this panel's tests address both slots through this
 * one module.
 */
export { BrowsersPanelActions } from "@/components/epic-canvas/sidebar/epic-browser-sidebar-header";

export function BrowsersPanelBody(props: LeftPanelSlotProps) {
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  return (
    <BrowserSessionsHostBoundary
      hostId={hostPin.resolvedHostId}
      epicId={props.epicId}
    >
      <BrowsersPanelBodyFrame epicId={props.epicId} tabId={props.tabId} />
    </BrowserSessionsHostBoundary>
  );
}

function BrowsersPanelBodyFrame(props: LeftPanelSlotProps) {
  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <BrowsersPanelBodyLive epicId={props.epicId} tabId={props.tabId} />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

function BrowsersPanelBodyLive(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const sessions = useBrowserSessionsContext();
  const searchQuery = usePanelHeaderSearchQuery(props.tabId, BROWSERS_PANEL_ID);
  const chats = useEpicChatRecords();
  const chatById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );
  const tabs = useBrowserSidebarTabRows(sessions.items);
  const { secondaryByKey, duplicateTitles } = useBrowserTabRowLabels(tabs);
  const filteredTabs = useMemo(
    () => filterBrowserTabRows(tabs, searchQuery),
    [searchQuery, tabs],
  );
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareFocus = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );
  const { add: addBrowser, isAdding } = useAddBrowserAction(
    props.epicId,
    props.tabId,
    null,
  );

  const openTab = useCallback(
    (session: BrowserSessionInfo, tab: BrowserTabInfo) => {
      const tile = makeBrowserSessionTileRef({
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      });
      const existingPointer = findOpenTileInTab(props.tabId, tile);
      navigateNested(props.epicId, props.tabId, () =>
        existingPointer === null
          ? prepareOpen(props.tabId, tile)
          : prepareFocus(
              props.tabId,
              existingPointer.paneId,
              existingPointer.instanceId,
            ),
      );
    },
    [navigateNested, prepareFocus, prepareOpen, props.epicId, props.tabId],
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
      const existing = findOpenTileInTab(props.tabId, chatTile);
      navigateNested(props.epicId, props.tabId, () =>
        existing === null
          ? prepareOpen(props.tabId, chatTile)
          : prepareFocus(props.tabId, existing.paneId, existing.instanceId),
      );
    },
    [
      chatById,
      navigateNested,
      prepareFocus,
      prepareOpen,
      props.epicId,
      props.tabId,
    ],
  );
  const isUnavailable =
    sessions.lifecycle === "failed" || sessions.lifecycle === "closed";
  const isLoading =
    (sessions.lifecycle === "connecting" ||
      sessions.lifecycle === "reconnecting") &&
    tabs.length === 0;
  const isEmpty = !isLoading && !isUnavailable && tabs.length === 0;
  const hasNoResults = tabs.length > 0 && filteredTabs.length === 0;
  const hasResults = filteredTabs.length > 0;

  return (
    <>
      <BrowserSearchHeaderInput
        tabId={props.tabId}
        resultCount={filteredTabs.length}
      />
      {isLoading ? <BrowsersPanelLoadingState /> : null}
      {isUnavailable ? (
        <BrowsersPanelUnavailableState
          message={sessions.errorMessage}
          onRetry={sessions.retry}
        />
      ) : null}
      {isEmpty ? (
        <BrowsersPanelEmptyState
          onAddBrowser={addBrowser}
          isAdding={isAdding}
        />
      ) : null}
      {hasNoResults ? <BrowsersPanelNoResultsState /> : null}
      {hasResults ? (
        <ul
          aria-label="Browser tabs"
          className="space-y-0.5"
          data-testid="epic-browsers-panel-list"
        >
          {filteredTabs.map(({ key, session, tab, identity }) => (
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
              onOpenTab={openTab}
              onOpenDrivingChat={openDrivingChat}
              onCloseTab={sessions.closeTab}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function BrowsersPanelLoadingState() {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground">
      <AgentSpinningDots
        className="shrink-0 text-muted-foreground/70"
        testId={undefined}
        variant={undefined}
      />
      <span>Loading browsers…</span>
    </div>
  );
}

export function BrowsersPanelNoResultsState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground">
      <Search className="size-6 text-muted-foreground/45" aria-hidden />
      <p className="text-ui-sm text-muted-foreground/60">
        No matching browsers.
      </p>
    </div>
  );
}

export function BrowsersPanelUnavailableState(props: {
  readonly message: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground">
      <TriangleAlert className="size-7 text-destructive/70" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-foreground/75">Browsers unavailable.</p>
        {props.message === null ? null : (
          <p className="text-ui-xs text-muted-foreground">{props.message}</p>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        <RotateCcw className="size-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}

export function BrowsersPanelEmptyState(props: {
  readonly onAddBrowser: () => void;
  readonly isAdding: boolean;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground"
      data-testid="epic-browsers-panel-empty"
    >
      <Globe2 className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/60">No browsers yet.</p>
        <p className="text-ui-xs text-muted-foreground/50">
          Agents open theirs here too.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.isAdding}
        onClick={props.onAddBrowser}
      >
        <Plus className="size-3.5" aria-hidden />
        Add browser
      </Button>
    </div>
  );
}
