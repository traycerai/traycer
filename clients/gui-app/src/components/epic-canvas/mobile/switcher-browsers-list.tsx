import { useCallback, useMemo, useState } from "react";
import { Bot, ListFilter, Moon, Plus, TriangleAlert, X } from "lucide-react";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import {
  SwitcherListHeader,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherSearchField } from "@/components/epic-canvas/mobile/switcher-search-field";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { browserTabDriverNames } from "@/components/epic-canvas/sidebar/browser-driver-coalescing";
import { browserTabOrigin } from "@/lib/browser-view/browser-tab-display";
import {
  BrowserHostFilterChoices,
  BROWSERS_PANEL_ID,
} from "@/components/epic-canvas/sidebar/epic-browser-sidebar-header";
import {
  BrowsersPanelEmptyState,
  BrowsersPanelLoadingState,
  BrowsersPanelNoResultsState,
  BrowsersPanelUnavailableState,
} from "@/components/epic-canvas/sidebar/epic-browser-sidebar";
import { useCoalescedBrowserTabDrivers } from "@/components/epic-canvas/sidebar/use-coalesced-browser-tab-drivers";
import { useAddBrowserAction } from "@/components/epic-canvas/sidebar/use-browser-add-action";
import {
  browserTabCloseLabel,
  useBrowserTabClose,
} from "@/components/epic-canvas/sidebar/use-browser-tab-close";
import {
  filterBrowserTabRows,
  useBrowserSidebarTabRows,
  useBrowserTabRowLabels,
  type BrowserSidebarTabRow,
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
  useIsActiveTile,
} from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Browsers category: every tab of every browser session the surface's host is
 * running, as a flat list.
 *
 * The rows, their settled identities, the search predicate, the four
 * load/unavailable/empty/no-results states and the close-and-retire-the-tile
 * action all come from the desktop Browsers panel's own layer, so the phone
 * lists exactly what the rail does and neither surface owns a private copy of
 * the rules. This file owns the touch chrome: 44px rows instead of the
 * desktop's 30px hover rows, the URL as a second line where desktop puts it in
 * a hover tooltip a finger can never summon, and the header's search / add /
 * host-filter cluster inline rather than in a rail header slot the sheet has
 * no room for.
 *
 * The host filter is the desktop panel's, reading and writing the same surface
 * pin, so a host chosen on either surface is the host both list from.
 */
export function SwitcherBrowsersList(props: SwitcherListProps) {
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  return (
    <BrowserSessionsHostBoundary
      hostId={hostPin.resolvedHostId}
      epicId={props.epicId}
    >
      <SwitcherBrowsersListLive {...props} />
    </BrowserSessionsHostBoundary>
  );
}

function SwitcherBrowsersListLive(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const sessions = useBrowserSessionsContext();
  const surfaceKey = useTabSurfaceKey("browsers", tabId);
  const hostPin = useSurfaceHostPin(surfaceKey);
  // Query state is the sheet's, not the panel-header search store's - see the
  // Agents list for why a query must not outlive a sheet that closes on the
  // first tap.
  const [searchQuery, setSearchQuery] = useState("");
  // Built once for the list, as the desktop panel builds it once in
  // `BrowsersPanelBodyLive` - a per-row map would redo the work for every
  // visible row on every chat update.
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
  // Dismissing on the tile rather than on the tap: a refusal reports itself
  // with a toast and opens nothing, and a sheet that left anyway would take the
  // unavailable state's Retry with it. Same rule the Terminals row follows,
  // which closes on `onLaunched`.
  const { add: handleAdd, isAdding } = useAddBrowserAction(
    epicId,
    tabId,
    onClose,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        search={
          <SwitcherSearchField
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search browsers…"
            label="Search browsers"
            clearLabel="Clear browser search"
            testIdPrefix="switcher-browsers-search"
          />
        }
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Add browser"
            data-testid="switcher-new-browser"
            className="text-muted-foreground hover:text-foreground"
            disabled={isAdding}
            onClick={handleAdd}
          >
            <Plus className="size-4" />
          </Button>
        }
        viewMenu={
          <SwitcherBrowserHostFilterMenu
            surfaceKey={surfaceKey}
            isPinned={hostPin.isPinned}
          />
        }
      />
      <SwitcherBrowsersBody
        tabs={tabs}
        filteredTabs={filteredTabs}
        secondaryByKey={secondaryByKey}
        duplicateTitles={duplicateTitles}
        chatById={chatById}
        epicId={epicId}
        tabId={tabId}
        onClose={onClose}
        onAddBrowser={handleAdd}
        isAddingBrowser={isAdding}
      />
    </div>
  );
}

function SwitcherBrowsersBody(props: {
  readonly tabs: readonly BrowserSidebarTabRow[];
  readonly filteredTabs: readonly BrowserSidebarTabRow[];
  readonly secondaryByKey: ReadonlyMap<string, string | null>;
  readonly duplicateTitles: ReadonlySet<string>;
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
  readonly onAddBrowser: () => void;
  readonly isAddingBrowser: boolean;
}) {
  const sessions = useBrowserSessionsContext();
  const { tabs, filteredTabs } = props;
  const isUnavailable =
    sessions.lifecycle === "failed" || sessions.lifecycle === "closed";
  const isLoading =
    (sessions.lifecycle === "connecting" ||
      sessions.lifecycle === "reconnecting") &&
    tabs.length === 0;
  const isEmpty = !isLoading && !isUnavailable && tabs.length === 0;
  const hasNoResults = tabs.length > 0 && filteredTabs.length === 0;
  return (
    <>
      {isLoading ? <BrowsersPanelLoadingState /> : null}
      {/* Rendered ABOVE the rows rather than instead of them, as the desktop
          panel does: a stream that drops does not un-open the tabs, and the
          rows are still the only way to reach them. Replacing the list with
          the banner would strand a phone user with tabs they can see nothing
          of. */}
      {isUnavailable ? (
        <BrowsersPanelUnavailableState
          message={sessions.errorMessage}
          onRetry={sessions.retry}
        />
      ) : null}
      {isEmpty ? (
        <BrowsersPanelEmptyState
          onAddBrowser={props.onAddBrowser}
          isAdding={props.isAddingBrowser}
        />
      ) : null}
      {hasNoResults ? <BrowsersPanelNoResultsState /> : null}
      {filteredTabs.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
          {filteredTabs.map((row) => (
            <SwitcherBrowserRow
              key={row.key}
              row={row}
              secondaryLabel={props.secondaryByKey.get(row.key) ?? null}
              isDuplicateTitle={props.duplicateTitles.has(row.identity.title)}
              chatById={props.chatById}
              epicId={props.epicId}
              tabId={props.tabId}
              onClose={props.onClose}
              onCloseTab={sessions.closeTab}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function SwitcherBrowserRow(props: {
  readonly row: BrowserSidebarTabRow;
  readonly secondaryLabel: string | null;
  readonly isDuplicateTitle: boolean;
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
  readonly onCloseTab: (sessionId: string, tabId: string) => Promise<void>;
}) {
  const { row, epicId, tabId, onClose } = props;
  const { session, tab, identity } = row;
  const activate = useSwitcherActivate(epicId, tabId, onClose);
  // One source for what this row POINTS AT; the refs below are both built from
  // it, so the identity cannot drift between the one `isActive` is judged
  // against and the one a tap opens.
  const tileIdentity = useMemo(
    () => ({
      hostId: session.hostId,
      sessionId: session.sessionId,
      tabId: tab.tabId,
    }),
    [session.hostId, session.sessionId, tab.tabId],
  );
  const tile = useMemo(
    () => makeBrowserSessionTileRef(tileIdentity),
    [tileIdentity],
  );
  // Host-scoped, like desktop: two fleet sessions sharing a tab id must not
  // both read as the current tile.
  const isActive = useIsActiveTile(tabId, tile.id, session.hostId);
  // A fresh ref per activation, not the memoized one: `instanceId` keys the
  // evicted-preview payloads a back navigation restores, so an open reusing a
  // previous open's instance would write over its own history entry. Every
  // sibling category mints one per tap for the same reason.
  const onSelect = useCallback(() => {
    activate(() => makeBrowserSessionTileRef(tileIdentity));
  }, [activate, tileIdentity]);

  return (
    <SwitcherListRow
      icon={
        <BrowserFavicon
          // The settled identity survives a transient status, so mid-navigation
          // it still holds the PREVIOUS document's favicon. Showing it beside
          // the new URL would label the row with the site it just left, so the
          // icon is withheld until the origins agree again - the same guard the
          // desktop row applies.
          faviconUrl={
            browserTabOrigin(tab.url) === browserTabOrigin(identity.url)
              ? identity.faviconUrl
              : null
          }
          isolated={session.profile === "isolated"}
          className="size-4"
        />
      }
      label={identity.title}
      // Desktop's row carries the hostname inline and the full URL in a hover
      // tooltip a finger cannot summon. With one secondary line to spend, the
      // URL is the one to spend it on: it says everything the hostname does
      // and separates two tabs of the same site, which is what desktop needs
      // its tab-id suffix for.
      secondaryLabel={identity.url}
      badge={<SwitcherBrowserStateBadge status={tab.status} />}
      active={isActive}
      onSelect={onSelect}
      selectTestId={`switcher-browser-row-${tab.tabId}`}
      actions={
        <SwitcherBrowserRowActions
          row={row}
          secondaryLabel={props.secondaryLabel}
          isDuplicateTitle={props.isDuplicateTitle}
          chatById={props.chatById}
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
          onCloseTab={props.onCloseTab}
        />
      }
    />
  );
}

/**
 * The tab's own state, as a glyph inside the row button: crashed, or asleep.
 * Non-interactive by construction - the row button cannot nest another button
 * - so the one state that IS actionable on desktop, "driven by an agent", is
 * rendered as a real button in the actions slot beside it instead.
 */
function SwitcherBrowserStateBadge(props: {
  readonly status: BrowserTabInfo["status"];
}) {
  if (props.status === "crashed") {
    return (
      <span
        role="img"
        className="flex size-4 shrink-0 items-center justify-center text-destructive"
        aria-label="Browser failed"
      >
        <TriangleAlert className="size-3.5" aria-hidden />
      </span>
    );
  }
  if (props.status === "dormant") {
    return (
      <span
        role="img"
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        aria-label="Browser asleep"
      >
        <Moon className="size-3.5" aria-hidden />
      </span>
    );
  }
  return null;
}

function SwitcherBrowserRowActions(props: {
  readonly row: BrowserSidebarTabRow;
  readonly secondaryLabel: string | null;
  readonly isDuplicateTitle: boolean;
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
  readonly onCloseTab: (sessionId: string, tabId: string) => Promise<void>;
}) {
  const { row, epicId, tabId, onClose } = props;
  const { session, tab, identity } = row;
  const { isClosing, close } = useBrowserTabClose({
    epicId,
    viewTabId: tabId,
    hostId: session.hostId,
    sessionId: session.sessionId,
    tabId: tab.tabId,
    title: identity.title,
    status: tab.status,
    onCloseTab: props.onCloseTab,
  });
  const closeLabel = browserTabCloseLabel({
    tabId: tab.tabId,
    title: identity.title,
    secondaryLabel: props.secondaryLabel,
    isDuplicateTitle: props.isDuplicateTitle,
    isClosing,
  });
  return (
    <>
      <SwitcherBrowserDriverButton
        row={row}
        chatById={props.chatById}
        epicId={epicId}
        tabId={tabId}
        onClose={onClose}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={isClosing}
        aria-label={closeLabel}
        data-testid={`switcher-browser-close-${tab.tabId}`}
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={close}
      >
        {isClosing ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <X className="size-4" aria-hidden />
        )}
      </Button>
    </>
  );
}

/** "Jump to the agent driving this tab", the desktop row's bot glyph as a row action. */
function SwitcherBrowserDriverButton(props: {
  readonly row: BrowserSidebarTabRow;
  readonly chatById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string }
  >;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { row, epicId, tabId, onClose } = props;
  const drivers = useCoalescedBrowserTabDrivers(row.tab.drivenBy);
  const { chatById } = props;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareFocus = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );
  const driver = drivers.length === 0 ? null : drivers[0];
  const chat = driver === null ? undefined : chatById.get(driver.chatId);
  const onSelect = useCallback(() => {
    if (chat === undefined) return;
    const chatTile = makeOpenableNodeRef({
      id: chat.id,
      instanceId: crypto.randomUUID(),
      type: "chat",
      name: chat.title,
      hostId: row.session.hostId,
    });
    const existing = findOpenTileInTab(tabId, chatTile);
    navigateNested(epicId, tabId, () =>
      existing === null
        ? prepareOpen(tabId, chatTile)
        : prepareFocus(tabId, existing.paneId, existing.instanceId),
    );
    onClose();
  }, [
    chat,
    epicId,
    navigateNested,
    onClose,
    prepareFocus,
    prepareOpen,
    row.session.hostId,
    tabId,
  ]);
  // A driver whose chat this epic's records cannot resolve has nowhere to jump
  // to, so it stays a state the row reports rather than an action it offers.
  if (chat === undefined) return null;
  const names = browserTabDriverNames(drivers, chatById);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Open driving chat: ${names.join(", ")}`}
      data-testid={`switcher-browser-driver-${row.tab.tabId}`}
      className="shrink-0 text-blue-500 hover:text-blue-500"
      onClick={onSelect}
    >
      <Bot className="size-4" aria-hidden />
    </Button>
  );
}

/**
 * The desktop panel's host filter, in the switcher's view-menu slot. The
 * desktop rail reaches it through a submenu because a rail has no width for
 * the host rows; the sheet has, so the choices are listed directly.
 */
function SwitcherBrowserHostFilterMenu(props: {
  readonly surfaceKey: string;
  readonly isPinned: boolean;
}) {
  const label = props.isPinned
    ? "Filter browsers by host, 1 filter active"
    : "Filter browsers by host";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-testid={`switcher-${BROWSERS_PANEL_ID}-filter`}
          className="relative text-muted-foreground hover:text-foreground"
        >
          <ListFilter className="size-4" />
          {props.isPinned ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] leading-none font-semibold text-background ring-1 ring-background"
            >
              1
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(50dvh,20rem)] max-w-64 min-w-52 overflow-y-auto"
        data-testid={`switcher-${BROWSERS_PANEL_ID}-filter-menu`}
      >
        <BrowserHostFilterChoices surfaceKey={props.surfaceKey} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
