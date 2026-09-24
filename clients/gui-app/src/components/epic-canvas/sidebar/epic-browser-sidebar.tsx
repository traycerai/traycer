import { Globe2, Plus, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
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
import {
  useEpicBrowsersElsewhere,
  type EpicBrowsersElsewhere,
} from "@/components/epic-canvas/sidebar/use-epic-browsers-elsewhere";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import {
  browserSessionTileId,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import { usePanelHeaderSearchQuery } from "@/stores/epics/panel-header-search-store";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
  useVisibleSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { revealSidebarNode } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

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
      scope={{ kind: "epic", epicId: props.epicId }}
    >
      <BrowsersPanelBodyFrame epicId={props.epicId} tabId={props.tabId} />
    </BrowserSessionsHostBoundary>
  );
}

function BrowsersPanelBodyFrame(props: LeftPanelSlotProps) {
  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1">
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
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  // Read whether or not the panel is empty - the empty state is the only
  // consumer today, but the read is a registry scan with no stream of its own,
  // so gating it on emptiness would buy nothing and add a branch.
  const elsewhere = useEpicBrowsersElsewhere({
    epicId: props.epicId,
    resolvedHostId: hostPin.resolvedHostId,
  });
  const listRef = useRef<HTMLUListElement>(null);
  const revealRequest = useSidebarNodeRevealRequest(props.tabId);
  const visibleRevealRequest = useVisibleSidebarNodeRevealRequest(props.tabId);
  const searchQuery = usePanelHeaderSearchQuery(props.tabId, BROWSERS_PANEL_ID);
  const chats = useEpicChatRecords();
  const chatById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );
  const tabs = useBrowserSidebarTabRows(sessions.items);
  const { secondaryByKey, duplicateTitles } = useBrowserTabRowLabels(tabs);
  const filteredTabs = useMemo(() => {
    const matches = filterBrowserTabRows(tabs, searchQuery);
    if (visibleRevealRequest === null) return matches;
    const matchKeys = new Set(matches.map((row) => row.key));
    return tabs.filter(
      (row) =>
        matchKeys.has(row.key) ||
        browserSessionTileId({
          sessionId: row.session.sessionId,
          tabId: row.tab.tabId,
        }) === visibleRevealRequest.nodeId,
    );
  }, [searchQuery, tabs, visibleRevealRequest]);
  const { openTile } = useEpicTileNavigation();
  const { add: addBrowser, isAdding } = useAddBrowserAction(props.tabId, null);

  useLayoutEffect(() => {
    if (revealRequest === null || listRef.current === null) return;
    if (
      !revealSidebarNode(
        listRef.current,
        revealRequest.nodeId,
        revealRequest.nonce,
      )
    ) {
      return;
    }
    clearSidebarNodeRevealRequest(props.tabId, revealRequest.nonce);
  }, [filteredTabs, props.tabId, revealRequest]);

  const openTab = useCallback(
    (session: BrowserSessionInfo, tab: BrowserTabInfo) => {
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
    (session: BrowserSessionInfo, tab: BrowserTabInfo) => {
      const tile = makeBrowserSessionTileRef({
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      });
      // `explicit` pins the tile, and the resolver promotes an existing
      // preview of it rather than opening a second instance.
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
  const isUnavailable =
    sessions.lifecycle === "failed" ||
    sessions.lifecycle === "closed" ||
    sessions.lifecycle === "unsupported";
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
          onRetry={sessions.lifecycle === "unsupported" ? null : sessions.retry}
        />
      ) : null}
      {isEmpty ? (
        <BrowsersPanelEmptyState
          onAddBrowser={addBrowser}
          isAdding={isAdding}
          elsewhere={elsewhere}
          onShowHost={hostPin.setSelection}
        />
      ) : null}
      {hasNoResults ? <BrowsersPanelNoResultsState /> : null}
      {hasResults ? (
        <ul
          ref={listRef}
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
              onOpenTabPermanently={openTabPermanently}
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
        className="shrink-0"
        testId={undefined}
        variant={undefined}
        tone="muted"
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

/**
 * `onRetry` is `null` when retrying cannot change the answer - a host with no
 * browser support at all. The message then carries the remedy (update the
 * host), and offering a Retry would only promise what the phone cannot do.
 */
export function BrowsersPanelUnavailableState(props: {
  readonly message: string | null;
  readonly onRetry: (() => void) | null;
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
      {props.onRetry === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </Button>
      )}
    </div>
  );
}

export function BrowsersPanelEmptyState(props: {
  readonly onAddBrowser: () => void;
  readonly isAdding: boolean;
  /**
   * Machines this task has browsers on that the panel is not showing, and how
   * to move it to one. Empty is the ordinary case and renders nothing extra.
   */
  readonly elsewhere: readonly EpicBrowsersElsewhere[];
  readonly onShowHost: (hostId: string) => void;
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
      {props.elsewhere.map((host) => (
        <BrowsersElsewhereOnHost
          key={host.hostId}
          host={host}
          onShowHost={props.onShowHost}
        />
      ))}
    </div>
  );
}

/**
 * "Nothing here, but this task has browsers over there" - one row per other
 * machine, which pins the panel to it.
 *
 * Its own component because the host's display name is a hook, and these are
 * a list. The pin is the panel's existing host filter written for it, so the
 * reader ends up where the filter menu would have taken them and the badge on
 * the filter button explains what changed.
 */
function BrowsersElsewhereOnHost(props: {
  readonly host: EpicBrowsersElsewhere;
  readonly onShowHost: (hostId: string) => void;
}) {
  const entry = useHostDirectoryEntryForHostId(props.host.hostId);
  const hostLabel = entry?.label ?? props.host.hostId;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => props.onShowHost(props.host.hostId)}
    >
      <Globe2 className="size-3.5" aria-hidden />
      <span className="min-w-0 truncate">
        {props.host.tabCount === 1
          ? `1 browser on ${hostLabel}`
          : `${props.host.tabCount} browsers on ${hostLabel}`}
      </span>
    </Button>
  );
}
