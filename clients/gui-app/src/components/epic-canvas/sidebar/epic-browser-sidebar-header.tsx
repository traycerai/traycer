import { ListFilter, Plus, RotateCcw, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";
import { useAddBrowserAction } from "@/components/epic-canvas/sidebar/use-browser-add-action";
import { BrowserSessionsHostBoundary } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { cn } from "@/lib/utils";
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

export const BROWSERS_PANEL_ID = "browsers";
const FOLLOW_ACTIVE_HOST_VALUE = "browser-follow-active-host";

export function BrowsersPanelActions(props: LeftPanelSlotProps) {
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  return (
    <BrowserSessionsHostBoundary
      hostId={hostPin.resolvedHostId}
      epicId={props.epicId}
    >
      <BrowsersPanelActionsLive {...props} />
    </BrowserSessionsHostBoundary>
  );
}

function BrowsersPanelActionsLive(props: LeftPanelSlotProps) {
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

/**
 * Search mode for the browsers panel - the same shape as the agent and
 * artifact panels (`ChatSearchHeaderInput`): one shared `PanelSearchField`
 * portaled into the header slot the panel traded its title row for.
 */
export function BrowserSearchHeaderInput(props: {
  readonly tabId: string;
  readonly resultCount: number;
}) {
  const { tabId } = props;
  const query = usePanelHeaderSearchQuery(tabId, BROWSERS_PANEL_ID);
  const headerSlot = usePanelHeaderSearchSlot(tabId, BROWSERS_PANEL_ID);
  const setSearchQuery = usePanelHeaderSearchStore(
    (state) => state.setSearchQuery,
  );
  const closeSearch = usePanelHeaderSearchStore((state) => state.closeSearch);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerSlot !== null) inputRef.current?.focus();
  }, [headerSlot]);

  const onSearchQueryChange = useCallback(
    (value: string) => setSearchQuery(tabId, BROWSERS_PANEL_ID, value),
    [setSearchQuery, tabId],
  );
  const exitSearch = useCallback(
    () => closeSearch(tabId, BROWSERS_PANEL_ID),
    [closeSearch, tabId],
  );
  const clearSearch = useCallback(() => {
    onSearchQueryChange("");
    inputRef.current?.focus();
  }, [onSearchQueryChange]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      exitSearch();
    },
    [exitSearch],
  );

  const inputRow = (
    <PanelSearchField
      value={query}
      onValueChange={onSearchQueryChange}
      onClear={clearSearch}
      onClose={exitSearch}
      onKeyDown={handleKeyDown}
      ref={inputRef}
      combobox={null}
      placeholder="Search browsers…"
      label="Search browsers"
      clearLabel="Clear browser search"
      closeLabel="Close browser search"
      testIdPrefix="epic-browser-search"
      className="h-7"
    />
  );

  return (
    <>
      {headerSlot === null ? null : createPortal(inputRow, headerSlot)}
      <p className="sr-only" role="status" aria-live="polite">
        {browserSearchStatusMessage(query, props.resultCount)}
      </p>
    </>
  );
}

function browserSearchStatusMessage(
  query: string,
  resultCount: number,
): string {
  if (query.trim().length === 0) return "";
  if (resultCount === 0) return "No browsers match your search.";
  return `${resultCount} browser ${resultCount === 1 ? "result" : "results"}.`;
}
