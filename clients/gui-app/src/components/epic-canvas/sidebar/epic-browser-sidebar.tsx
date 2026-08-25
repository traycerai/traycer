import { useDraggable } from "@dnd-kit/core";
import {
  Bot,
  Globe2,
  ListFilter,
  Moon,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type {
  BrowserSessionInfo,
  BrowserTabDriver,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import {
  BROWSER_TILE_DND_TYPE,
  getBrowserTileDragId,
  getPaneScopedDndId,
  type EpicCanvasBrowserTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { BrowserSessionsHostProvider } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import {
  useSurfaceHostClient,
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  BROWSER_TAB_AGENT_ACTIVITY_MS,
  browserTabOrigin,
  disambiguateSecondaryLabels,
  nextSettledTabIdentity,
  type SettledTabIdentity,
} from "@/lib/browser-view/browser-tab-display";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { cn } from "@/lib/utils";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import {
  DEFAULT_BROWSER_TILE_NAME,
  DEFAULT_BROWSER_TILE_URL,
  DEFAULT_BROWSER_VIEWPORT_PRESET,
  makeBrowserSessionTileRef,
  makeBrowserTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchQuery,
  usePanelHeaderSearchSlot,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import {
  usePanelHeaderMenuOpen,
  usePanelHeaderMenuStore,
} from "@/stores/epics/panel-header-menu-store";

const BROWSERS_PANEL_ID = "browsers";
const FOLLOW_ACTIVE_HOST_VALUE = "browser-follow-active-host";

function resolveCloseAriaLabel(
  tabId: string,
  title: string,
  secondaryLabel: string | null,
  isDuplicateTitle: boolean,
): string {
  if (!isDuplicateTitle) return `Close ${title}`;
  return `Close ${title} (${secondaryLabel ?? tabId})`;
}

/**
 * Shared open-a-new-browser-tile action behind both the panel header's "Add
 * browser" button and the empty-state's own button - the same tile-open path
 * the pane opener's "New browser" command uses.
 */
function useAddBrowserAction(epicId: string, tabId: string): () => void {
  const surfaceKey = useTabSurfaceKey("browsers", tabId);
  const hostId =
    useSurfaceHostPin(surfaceKey).resolvedHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  return useCallback(() => {
    navigateNested(epicId, tabId, () =>
      prepareOpen(
        tabId,
        makeBrowserTileRef({
          name: DEFAULT_BROWSER_TILE_NAME,
          hostId,
          url: DEFAULT_BROWSER_TILE_URL,
          viewportPreset: DEFAULT_BROWSER_VIEWPORT_PRESET,
        }),
      ),
    );
  }, [epicId, hostId, navigateNested, prepareOpen, tabId]);
}

export function BrowsersPanelActions(props: LeftPanelSlotProps) {
  const collapsed = useLeftPanelSectionCollapsed("browsers");
  const searchOpen = usePanelHeaderSearchOpen(props.tabId, BROWSERS_PANEL_ID);
  const setPanelSectionCollapsed = useEpicLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );
  const openSearch = usePanelHeaderSearchStore((state) => state.openSearch);
  const surfaceKey = useTabSurfaceKey("browsers", props.tabId);
  const hostPin = useSurfaceHostPin(surfaceKey);
  const filterOpen = usePanelHeaderMenuOpen(
    props.tabId,
    BROWSERS_PANEL_ID,
    "filter",
  );
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const resolvedHost = useHostDirectoryEntryForHostId(hostPin.resolvedHostId);
  const addBrowser = useAddBrowserAction(props.epicId, props.tabId);
  const handleAdd = useCallback(() => {
    if (collapsed) setPanelSectionCollapsed("browsers", false);
    addBrowser();
  }, [addBrowser, collapsed, setPanelSectionCollapsed]);
  const handleSearch = useCallback(() => {
    if (collapsed) setPanelSectionCollapsed("browsers", false);
    openSearch(props.tabId, BROWSERS_PANEL_ID, "");
  }, [collapsed, openSearch, props.tabId, setPanelSectionCollapsed]);
  const handleFilterOpenChange = useCallback(
    (open: boolean) => {
      if (open && collapsed) setPanelSectionCollapsed("browsers", false);
      if (!open) setHostMenuOpen(false);
      setMenuOpen(props.tabId, BROWSERS_PANEL_ID, "filter", open);
    },
    [collapsed, props.tabId, setMenuOpen, setPanelSectionCollapsed],
  );
  const filterLabel = hostPin.isPinned
    ? "Filter browsers by host, 1 filter active"
    : "Filter browsers by host";
  const hostSummary =
    resolvedHost?.label ?? (hostPin.isPinned ? "Selected host" : "Active host");
  return (
    <>
      {searchOpen ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Search browsers"
          data-testid="epic-browsers-panel-search"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleSearch}
        >
          <Search className="size-4" aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Add browser"
        data-testid="epic-browsers-panel-add"
        className="text-muted-foreground hover:text-foreground"
        onClick={handleAdd}
      >
        <Plus className="size-4" aria-hidden />
      </Button>
      <DropdownMenu open={filterOpen} onOpenChange={handleFilterOpenChange}>
        <TooltipWrapper
          label={filterLabel}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={filterLabel}
              data-testid="epic-browsers-panel-filter"
              className={cn(
                "relative text-muted-foreground transition-colors hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
                hostPin.isPinned && "bg-accent text-accent-foreground",
              )}
            >
              <ListFilter className="size-4" aria-hidden />
              {hostPin.isPinned ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] leading-none font-semibold text-background ring-1 ring-background"
                >
                  1
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipWrapper>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={8}
          avoidCollisions={false}
          className="w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-64 overflow-y-auto"
          data-testid="epic-browsers-panel-filter-menu"
        >
          <DropdownMenuLabel className="mt-1 text-overline uppercase tracking-wide">
            Filters
          </DropdownMenuLabel>
          <DropdownMenuSub open={hostMenuOpen} onOpenChange={setHostMenuOpen}>
            <DropdownMenuSubTrigger
              aria-label={`Host, ${hostSummary}`}
              className="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-1.5 [&>svg:last-child]:ml-0 [&>svg:last-child]:justify-self-end"
              onClick={() => setHostMenuOpen(true)}
            >
              <span className="min-w-0 truncate">Host</span>
              <span className="min-w-0 truncate text-right text-ui-xs text-muted-foreground group-data-open:text-accent-foreground">
                {hostSummary}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              sideOffset={8}
              alignOffset={-4}
              avoidCollisions={false}
              className="w-[min(90vw,20rem)]"
              data-testid="epic-browsers-panel-host-menu"
            >
              <BrowserHostFilterChoices surfaceKey={surfaceKey} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function BrowserHostFilterChoices(props: { readonly surfaceKey: string }) {
  const options = useHostOptions();
  const hostPin = useSurfaceHostPin(props.surfaceKey);
  const value = hostPin.selection ?? FOLLOW_ACTIVE_HOST_VALUE;
  const activeHostName =
    options.hosts.find((host) => host.hostId === options.activeHostId)?.name ??
    "Active host";
  return (
    <>
      <DropdownMenuLabel>Show browsers from</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value}>
        <DropdownMenuRadioItem
          value={FOLLOW_ACTIVE_HOST_VALUE}
          onSelect={(event) => {
            event.preventDefault();
            hostPin.setSelection(null);
          }}
        >
          <span className="min-w-0 flex-1 truncate">Follow active host</span>
          <DropdownMenuShortcut>{activeHostName}</DropdownMenuShortcut>
        </DropdownMenuRadioItem>
        {options.hosts.length > 0 ? <DropdownMenuSeparator /> : null}
        {options.hosts.map((host) => (
          <DropdownMenuRadioItem
            key={host.hostId}
            value={host.hostId}
            disabled={
              !isHostOptionSelectable(
                host,
                "pin",
                AVAILABLE_HOST_ROW_SURFACE_STATE,
              )
            }
            onSelect={(event) => {
              event.preventDefault();
              hostPin.setSelection(host.hostId);
            }}
          >
            <HostOptionRow
              host={host}
              picked={hostPin.selection === host.hostId}
              active={host.hostId === options.activeHostId}
              intent="pin"
              surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
            />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {options.isLoading ? (
        <DropdownMenuItem disabled>
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
          {options.hosts.length === 0
            ? "Loading hosts…"
            : "Loading more hosts…"}
        </DropdownMenuItem>
      ) : null}
      {!options.isLoading &&
      options.hosts.length === 0 &&
      !options.listsFailed ? (
        <DropdownMenuItem disabled>No hosts available</DropdownMenuItem>
      ) : null}
      {options.listsFailed && !options.isLoading ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              options.retryLists();
            }}
          >
            <RotateCcw className="size-4" aria-hidden />
            {options.hosts.length === 0
              ? "Try loading hosts again"
              : "Some hosts may be missing"}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

export function BrowsersPanelBody(props: LeftPanelSlotProps) {
  const canvasHostId = useCanvasHostId();
  const surfaceKey = useTabSurfaceKey("browsers", props.tabId);
  const hostPin = useSurfaceHostPin(surfaceKey);
  const hostClient = useSurfaceHostClient(hostPin.resolvedHostId);
  const body = (
    <BrowsersPanelBodyFrame epicId={props.epicId} tabId={props.tabId} />
  );
  if (hostPin.resolvedHostId === canvasHostId) return body;
  return (
    <BrowserSessionsHostProvider
      hostId={hostPin.resolvedHostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {body}
    </BrowserSessionsHostProvider>
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

type BrowserSidebarTabRow = {
  readonly key: string;
  readonly session: BrowserSessionInfo;
  readonly tab: BrowserTabInfo;
  readonly identity: SettledTabIdentity;
};

function nextBrowserSidebarTabRows(
  previous: readonly BrowserSidebarTabRow[],
  sessions: readonly BrowserSessionInfo[],
): readonly BrowserSidebarTabRow[] {
  const previousByKey = new Map(previous.map((row) => [row.key, row]));
  const next = sessions.flatMap((session) =>
    session.tabs.map((tab) => {
      const key = `${session.hostId}:${session.sessionId}:${tab.tabId}`;
      return {
        key,
        session,
        tab,
        identity: nextSettledTabIdentity(
          previousByKey.get(key)?.identity ?? null,
          tab,
        ),
      };
    }),
  );
  const nextByKey = new Map(next.map((row) => [row.key, row]));
  return [
    ...previous.flatMap((row) => {
      const current = nextByKey.get(row.key);
      return current === undefined ? [] : [current];
    }),
    ...next.filter((row) => !previousByKey.has(row.key)),
  ];
}

function useBrowserSidebarTabRows(
  sessions: readonly BrowserSessionInfo[],
): readonly BrowserSidebarTabRow[] {
  const [state, setState] = useState(() => ({
    sessions,
    rows: nextBrowserSidebarTabRows([], sessions),
  }));
  if (state.sessions === sessions) return state.rows;
  const rows = nextBrowserSidebarTabRows(state.rows, sessions);
  setState({ sessions, rows });
  return rows;
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
  const secondaryByKey = useMemo(
    () =>
      disambiguateSecondaryLabels(
        tabs.map((row) => ({
          key: row.key,
          tabId: row.tab.tabId,
          title: row.identity.title,
          url: row.identity.url,
        })),
      ),
    [tabs],
  );
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    tabs.forEach((row) => {
      counts.set(row.identity.title, (counts.get(row.identity.title) ?? 0) + 1);
    });
    const duplicates = new Set<string>();
    counts.forEach((count, title) => {
      if (count > 1) duplicates.add(title);
    });
    return duplicates;
  }, [tabs]);
  const filteredTabs = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (query.length === 0) return tabs;
    return tabs.filter(({ identity }) =>
      `${identity.title} ${identity.url}`.toLocaleLowerCase().includes(query),
    );
  }, [searchQuery, tabs]);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareFocus = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );
  const addBrowser = useAddBrowserAction(props.epicId, props.tabId);

  const openTab = useCallback(
    (session: BrowserSessionInfo, tab: BrowserTabInfo) => {
      const tile = makeBrowserSessionTileRef({
        name: tab.title ?? session.name,
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
      {isEmpty ? <BrowsersPanelEmptyState onAddBrowser={addBrowser} /> : null}
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

function BrowserSearchHeaderInput(props: {
  readonly tabId: string;
  readonly resultCount: number;
}) {
  const query = usePanelHeaderSearchQuery(props.tabId, BROWSERS_PANEL_ID);
  const headerSlot = usePanelHeaderSearchSlot(props.tabId, BROWSERS_PANEL_ID);
  const setSearchQuery = usePanelHeaderSearchStore(
    (state) => state.setSearchQuery,
  );
  const closeSearch = usePanelHeaderSearchStore((state) => state.closeSearch);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerSlot !== null) inputRef.current?.focus();
  }, [headerSlot]);

  const exitSearch = useCallback(
    () => closeSearch(props.tabId, BROWSERS_PANEL_ID),
    [closeSearch, props.tabId],
  );
  const clearSearch = useCallback(() => {
    setSearchQuery(props.tabId, BROWSERS_PANEL_ID, "");
    inputRef.current?.focus();
  }, [props.tabId, setSearchQuery]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      exitSearch();
    },
    [exitSearch],
  );
  const input = (
    <InputGroup className="h-7 w-full">
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) =>
          setSearchQuery(props.tabId, BROWSERS_PANEL_ID, event.target.value)
        }
        onKeyDown={handleKeyDown}
        placeholder="Search browsers…"
        aria-label="Search browsers"
        autoComplete="off"
        spellCheck={false}
        className="text-ui-sm"
        data-testid="epic-browser-search-input"
      />
      <InputGroupAddon align="inline-end">
        {query.length === 0 ? null : (
          <InputGroupButton
            type="button"
            size="icon-xs"
            aria-label="Clear browser search"
            onClick={clearSearch}
          >
            <X className="size-3.5" aria-hidden />
          </InputGroupButton>
        )}
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label="Close browser search"
          onClick={exitSearch}
        >
          <span aria-hidden className="text-overline uppercase">
            esc
          </span>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
  const trimmed = query.trim();
  let status = "";
  if (trimmed.length > 0 && props.resultCount === 0) {
    status = "No browsers match your search.";
  } else if (trimmed.length > 0) {
    const noun = props.resultCount === 1 ? "result" : "results";
    status = `${props.resultCount} browser ${noun}.`;
  }
  return (
    <>
      {headerSlot === null ? null : createPortal(input, headerSlot)}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}

function BrowsersPanelLoadingState() {
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

function BrowsersPanelNoResultsState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground">
      <Search className="size-6 text-muted-foreground/45" aria-hidden />
      <p className="text-ui-sm text-muted-foreground/60">
        No matching browsers.
      </p>
    </div>
  );
}

function BrowsersPanelUnavailableState(props: {
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

function BrowsersPanelEmptyState(props: { readonly onAddBrowser: () => void }) {
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
        onClick={props.onAddBrowser}
      >
        <Plus className="size-3.5" aria-hidden />
        Add browser
      </Button>
    </div>
  );
}

interface BrowserTabRowProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly session: BrowserSessionInfo;
  readonly tab: BrowserTabInfo;
  readonly identity: SettledTabIdentity;
  readonly secondaryLabel: string | null;
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly duplicateTitles: ReadonlySet<string>;
  readonly onOpenTab: (
    session: BrowserSessionInfo,
    tab: BrowserTabInfo,
  ) => void;
  readonly onOpenDrivingChat: (
    driver: BrowserTabDriver,
    hostId: string,
  ) => void;
  readonly onCloseTab: (sessionId: string, tabId: string) => Promise<void>;
}

function browserTabStateLabel(
  status: BrowserTabInfo["status"],
  isClosing: boolean,
): string {
  if (status === "crashed") return ", failed";
  if (isClosing) return ", closing";
  if (status === "dormant") return ", asleep";
  return "";
}

function BrowserTabRow(props: BrowserTabRowProps) {
  const {
    epicId,
    viewTabId,
    session,
    tab,
    identity,
    secondaryLabel,
    chatById,
    duplicateTitles,
    onOpenTab,
    onOpenDrivingChat,
    onCloseTab,
  } = props;
  const title = identity.title;
  const isFailed = tab.status === "crashed";
  const [closePending, setClosePending] = useState(false);
  const isClosing = tab.status === "closing" || closePending;
  const visibleDrivers = useCoalescedBrowserTabDrivers(tab.drivenBy);
  const closeAriaLabel = resolveCloseAriaLabel(
    tab.tabId,
    title,
    secondaryLabel,
    duplicateTitles.has(title),
  );
  const tile = useMemo(
    () =>
      makeBrowserSessionTileRef({
        name: tab.title ?? session.name,
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      }),
    [session.hostId, session.name, session.sessionId, tab.tabId, tab.title],
  );
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareClose = useEpicCanvasStore(
    (state) => state.prepareCloseCanvasTabFocusTarget,
  );
  const handleClose = useCallback(() => {
    if (isClosing) return;
    setClosePending(true);
    void onCloseTab(session.sessionId, tab.tabId)
      .then(() => {
        const pointer = findOpenTileInTab(viewTabId, tile);
        if (pointer !== null) {
          navigateNested(epicId, viewTabId, () =>
            prepareClose(viewTabId, pointer.paneId, pointer.instanceId),
          );
        }
      })
      .catch(() => {
        toast.error(`Couldn't close ${title}. Try again.`, {
          duration: Infinity,
        });
        setClosePending(false);
      });
  }, [
    epicId,
    isClosing,
    navigateNested,
    onCloseTab,
    prepareClose,
    session.sessionId,
    tab.tabId,
    tile,
    title,
    viewTabId,
  ]);
  const isActive = useEpicCanvasStore((state) => {
    const canvas = state.canvasByTabId[viewTabId];
    if (canvas === undefined || canvas.activePaneId === null) return false;
    const activeInstanceId =
      findPaneById(canvas.root, canvas.activePaneId)?.activeTabId ?? null;
    if (activeInstanceId === null) return false;
    const active = canvas.tilesByInstanceId[activeInstanceId];
    if (active?.hostId !== session.hostId) return false;
    return active.id === tile.id;
  });
  const dragTile = tile;
  const dragData = useMemo<EpicCanvasBrowserTileDragData>(
    () => ({
      kind: BROWSER_TILE_DND_TYPE,
      epicId,
      viewTabId,
      tile: dragTile,
    }),
    [dragTile, epicId, viewTabId],
  );
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(
      viewTabId,
      getBrowserTileDragId(session.sessionId, tab.tabId),
    ),
    data: dragData,
  });

  const stateLabel = browserTabStateLabel(tab.status, isClosing);

  return (
    <li>
      <div
        data-active={isActive}
        data-testid={`epic-browser-sidebar-row-${tab.tabId}`}
        className={cn(
          "group/browser-row relative grid h-8 min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_24px_28px] items-center rounded-md transition-colors duration-100 motion-reduce:transition-none",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
          isClosing && "opacity-60",
          isDragging && "cursor-grabbing opacity-60",
        )}
      >
        <TooltipWrapper
          label={identity.url}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            ref={dragRef}
            {...attributes}
            {...listeners}
            type="button"
            aria-label={`${title}, ${identity.url}${stateLabel}`}
            className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 pr-1 text-left text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            onClick={() => onOpenTab(session, tab)}
          >
            <BrowserFavicon
              faviconUrl={
                browserTabOrigin(tab.url) === browserTabOrigin(identity.url)
                  ? identity.faviconUrl
                  : null
              }
              isolated={session.profile === "isolated"}
              className="size-4"
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {secondaryLabel === null ? null : (
                <span className="max-w-[42%] min-w-0 shrink truncate text-ui-xs font-normal text-muted-foreground">
                  {secondaryLabel}
                </span>
              )}
            </span>
          </button>
        </TooltipWrapper>
        <span className="flex size-6 items-center justify-center justify-self-center">
          <BrowserTabStateSlot
            isFailed={isFailed}
            isClosing={isClosing}
            isDormant={tab.status === "dormant"}
            drivers={visibleDrivers}
            chatById={chatById}
            onOpenDrivingChat={(driver) =>
              onOpenDrivingChat(driver, session.hostId)
            }
          />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={isClosing}
          aria-label={
            isClosing
              ? closeAriaLabel.replace("Close ", "Closing ")
              : closeAriaLabel
          }
          data-testid={`epic-browser-sidebar-close-${tab.tabId}`}
          className={cn(
            "size-6 cursor-pointer justify-self-center text-muted-foreground opacity-0 transition-opacity duration-100 pointer-events-none motion-reduce:transition-none",
            "group-focus-within/browser-row:pointer-events-auto group-focus-within/browser-row:opacity-100",
            "group-hover/browser-row:pointer-events-auto group-hover/browser-row:opacity-100",
            "group-data-[active=true]/browser-row:pointer-events-auto group-data-[active=true]/browser-row:opacity-100",
            "hover:bg-destructive/10 hover:text-destructive",
            "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
            (isFailed || isClosing) && "pointer-events-auto opacity-100",
          )}
          onClick={handleClose}
        >
          {isClosing ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </li>
  );
}

function BrowserTabStateSlot(props: {
  readonly isFailed: boolean;
  readonly isClosing: boolean;
  readonly isDormant: boolean;
  readonly drivers: readonly BrowserTabDriver[];
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly onOpenDrivingChat: (driver: BrowserTabDriver) => void;
}) {
  if (props.isFailed) {
    return (
      <TooltipWrapper
        label="Browser failed. Open to recover."
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          className="flex size-6 items-center justify-center text-destructive"
          aria-hidden
        >
          <TriangleAlert className="size-3.5" />
        </span>
      </TooltipWrapper>
    );
  }
  if (props.isClosing) return null;
  if (props.drivers.length > 0) {
    const driver = props.drivers[0];
    const names = [
      ...new Set(
        props.drivers.map(
          (candidate) =>
            props.chatById.get(candidate.chatId)?.title ?? candidate.chatId,
        ),
      ),
    ];
    const label = `Driven by ${names.join(", ")}`;
    return (
      <TooltipWrapper
        label={label}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-label={`Open driving chat: ${names.join(", ")}`}
          className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-blue-500 outline-none hover:bg-blue-500/10 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onOpenDrivingChat(driver)}
        >
          <Bot className="size-3.5" aria-hidden />
        </button>
      </TooltipWrapper>
    );
  }
  if (props.isDormant) {
    return (
      <TooltipWrapper
        label="Browser asleep"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          className="flex size-6 items-center justify-center text-muted-foreground"
          aria-hidden
        >
          <Moon className="size-3.5" />
        </span>
      </TooltipWrapper>
    );
  }
  return null;
}

function useCoalescedBrowserTabDrivers(
  drivenBy: readonly BrowserTabDriver[],
): readonly BrowserTabDriver[] {
  const [visible, setVisible] = useState<readonly BrowserTabDriver[]>([]);
  const drivenByRef = useRef(drivenBy);
  const visibleRef = useRef(visible);
  const showTimerRef = useRef<number | null>(null);
  const showChatSignatureRef = useRef<string | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const signature = drivenBy
    .map((driver) => `${driver.chatId}\0${driver.requestId}`)
    .join("\x01");
  const chatSignature = [...new Set(drivenBy.map((driver) => driver.chatId))]
    .sort()
    .join("\0");

  useEffect(() => {
    drivenByRef.current = drivenBy;
    visibleRef.current = visible;
  }, [drivenBy, visible]);

  useEffect(() => {
    const hasDrivers = drivenByRef.current.length > 0;
    if (hasDrivers) {
      if (visibleRef.current.length > 0) {
        const visibleChats = new Set(
          visibleRef.current.map((driver) => driver.chatId),
        );
        const staysWithinVisibleChats = drivenByRef.current.every((driver) =>
          visibleChats.has(driver.chatId),
        );
        if (staysWithinVisibleChats) {
          if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
          }
          setVisible(drivenByRef.current);
          return;
        }
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        visibleRef.current = [];
        setVisible([]);
      }
      if (
        showTimerRef.current !== null &&
        showChatSignatureRef.current !== chatSignature
      ) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (showTimerRef.current !== null) return;
      showChatSignatureRef.current = chatSignature;
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        showChatSignatureRef.current = null;
        setVisible(drivenByRef.current);
      }, BROWSER_TAB_AGENT_ACTIVITY_MS);
      return;
    }
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      showChatSignatureRef.current = null;
    }
    if (visibleRef.current.length === 0) return;
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible([]);
    }, BROWSER_TAB_AGENT_ACTIVITY_MS);
  }, [chatSignature, signature]);

  useEffect(
    () => () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
      }
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    },
    [],
  );

  return visible;
}
