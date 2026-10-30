import { ListFilter, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";
import { BrowserCreatePicker } from "./browser-create-picker";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  pickableHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useBrowserPanelPreferences } from "@/stores/epics/browser-panel-store";
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
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";

export const BROWSERS_PANEL_ID = "browsers";
const FOLLOW_TASK_HOST_VALUE = "browser-follow-task-host";

export function BrowsersPanelActions(props: LeftPanelSlotProps) {
  const searchOpen = usePanelHeaderSearchOpen(props.tabId, BROWSERS_PANEL_ID);
  const openSearch = usePanelHeaderSearchStore((state) => state.openSearch);
  return (
    <>
      {searchOpen ? null : (
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label="Search browsers"
          data-testid="epic-browsers-panel-search"
          onClick={() => openSearch(props.tabId, BROWSERS_PANEL_ID, "")}
        >
          <Search className="size-4" aria-hidden />
        </Button>
      )}
      <BrowserCreatePicker
        epicId={props.epicId}
        tabId={props.tabId}
        onOpened={null}
        testId="epic-browsers-panel-add"
        trigger="icon"
      />
      <BrowserOfflineFilter
        epicId={props.epicId}
        tabId={props.tabId}
        mobile={false}
      />
    </>
  );
}

/** One offline preference shared by the rail and task switcher. */
export function BrowserOfflineFilter(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly mobile: boolean;
}) {
  const preferences = useBrowserPanelPreferences(props.epicId);
  const filterOpen = usePanelHeaderMenuOpen(
    props.tabId,
    BROWSERS_PANEL_ID,
    "filter",
  );
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const placement = useColumnOverlayPlacement("row");
  const label = preferences.showOffline
    ? "Filter browsers, 1 filter active"
    : "Filter browsers";
  const surfaceKey = useTabSurfaceKey("browsers", props.tabId);
  return (
    <DropdownMenu
      open={filterOpen}
      onOpenChange={(open) =>
        setMenuOpen(props.tabId, BROWSERS_PANEL_ID, "filter", open)
      }
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label={label}
          data-testid={
            props.mobile
              ? "switcher-browsers-filter"
              : "epic-browsers-panel-filter"
          }
          className="relative"
        >
          <ListFilter className="size-4" aria-hidden />
          {preferences.showOffline ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-micro leading-none font-semibold text-background ring-1 ring-background"
            >
              1
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={props.mobile ? "bottom" : (placement?.side ?? "right")}
        align={props.mobile ? "end" : (placement?.align ?? "start")}
        className="w-max"
        data-testid="epic-browsers-panel-filter-menu"
      >
        <DropdownMenuCheckboxItem
          checked={preferences.showOffline}
          onCheckedChange={preferences.setShowOffline}
        >
          Show offline devices
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Open links on</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[min(90vw,20rem)]">
            <BrowserHostFilterChoices surfaceKey={surfaceKey} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The machine a link opened from this task lands on: the Browsers surface
 * pin `useBrowserOpenHost` reads. Browser discovery does not read or write
 * this selection.
 */
export function BrowserHostFilterChoices(props: {
  readonly surfaceKey: string;
}) {
  const options = useHostOptions();
  const hostPin = useSurfaceHostPin(props.surfaceKey);
  const value = hostPin.selection ?? FOLLOW_TASK_HOST_VALUE;
  // A picker: no burst sandbox (see `pickableHostOptions`); the pinned host
  // always keeps its row.
  const pickableHosts = pickableHostOptions(options.hosts, hostPin.selection);
  const followingHostName =
    options.hosts.find((host) => host.hostId === hostPin.followingHostId)
      ?.name ?? "Task host";
  return (
    <>
      <DropdownMenuLabel>Open links on</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value}>
        <DropdownMenuRadioItem
          value={FOLLOW_TASK_HOST_VALUE}
          onSelect={(event) => {
            event.preventDefault();
            hostPin.setSelection(null);
          }}
        >
          <span className="min-w-0 flex-1 truncate">Follow task device</span>
          <DropdownMenuShortcut>{followingHostName}</DropdownMenuShortcut>
        </DropdownMenuRadioItem>
        {pickableHosts.length > 0 ? <DropdownMenuSeparator /> : null}
        {pickableHosts.map((host) => (
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
              wakeSandboxOnPick(host, null);
              hostPin.setSelection(host.hostId);
            }}
          >
            <HostOptionRow
              host={host}
              picked={hostPin.selection === host.hostId}
              active={host.hostId === options.activeHostId}
              intent="pin"
              surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
              updateView={null}
              nameRef={null}
              nameWraps={false}
              environmentLabel={null}
            />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {options.isLoading ? (
        <DropdownMenuItem disabled>
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
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
