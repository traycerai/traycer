import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { Bot, Moon, TriangleAlert, X } from "lucide-react";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import { SwitcherListHeader, SwitcherListRow } from "./switcher-list-row";
import { SwitcherSearchField } from "./switcher-search-field";
import { useSwitcherActivate } from "./use-switcher-activate";
import { browserTabDriverNames } from "@/components/epic-canvas/sidebar/browser-driver-coalescing";
import { browserTabOrigin } from "@/lib/browser-view/browser-tab-display";
import { BrowserOfflineFilter } from "@/components/epic-canvas/sidebar/epic-browser-sidebar-header";
import { BrowserCreatePicker } from "@/components/epic-canvas/sidebar/browser-create-picker";
import { BrowserDeviceGroup } from "@/components/epic-canvas/sidebar/browser-device-group";
import { BrowserListFeedback } from "@/components/epic-canvas/sidebar/browser-list-feedback";
import { useBrowserListModel } from "@/components/epic-canvas/sidebar/use-browser-list-model";
import { useCoalescedBrowserTabDrivers } from "@/components/epic-canvas/sidebar/use-coalesced-browser-tab-drivers";
import {
  browserTabCloseLabel,
  useBrowserTabClose,
} from "@/components/epic-canvas/sidebar/use-browser-tab-close";
import {
  useBrowserTabRowLabels,
  type BrowserSidebarTabRow,
} from "@/components/epic-canvas/sidebar/use-browser-tab-rows";
import { useBrowserListTabClose } from "@/components/epic-canvas/sidebar/use-browser-list-tab-close";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/** Task-wide browser discovery with touch controls. */
export function SwitcherBrowsersList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const model = useBrowserListModel(epicId, searchQuery, null);
  const chats = useEpicChatRecords();
  const chatById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );
  const { secondaryByKey, duplicateTitles } = useBrowserTabRowLabels(
    model.rows,
  );
  const closeTab = useBrowserListTabClose(epicId);
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
          <BrowserCreatePicker
            epicId={epicId}
            tabId={tabId}
            onOpened={onClose}
            testId="switcher-new-browser"
            trigger="icon"
          />
        }
        viewMenu={<BrowserOfflineFilter epicId={epicId} tabId={tabId} mobile />}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
        <BrowserListFeedback
          model={model}
          epicId={epicId}
          tabId={tabId}
          query={searchQuery}
          onClearSearch={() => setSearchQuery("")}
          onOpened={onClose}
        />
        <div className="min-w-0 space-y-1">
          {model.groups.map((group) => (
            <BrowserDeviceGroup
              key={group.hostId}
              group={group}
              mobile
              onExpandedChange={(hostId, expanded) =>
                model.preferences.setCollapsed(hostId, !expanded)
              }
            >
              <div className="flex flex-col gap-0.5">
                {group.rows.map((row) => (
                  <SwitcherBrowserRow
                    key={row.key}
                    row={row}
                    secondaryLabel={secondaryByKey.get(row.key) ?? null}
                    isDuplicateTitle={duplicateTitles.has(row.identity.title)}
                    chatById={chatById}
                    epicId={epicId}
                    tabId={tabId}
                    onClose={onClose}
                    unavailable={group.offline}
                    onCloseTab={(_sessionId, tabId) =>
                      closeTab(row.session, tabId)
                    }
                  />
                ))}
              </div>
            </BrowserDeviceGroup>
          ))}
        </div>
      </div>
    </div>
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
  readonly unavailable: boolean;
}) {
  const { row, epicId, tabId, onClose } = props;
  const { session, tab, identity } = row;
  const activate = useSwitcherActivate(tabId, onClose);
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
      disabled={props.unavailable}
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
          unavailable={props.unavailable}
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
  readonly status: BrowserTabInfo["status"] | null;
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
  readonly unavailable: boolean;
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
        tabId={tabId}
        onClose={onClose}
      />
      <Button
        type="button"
        variant="muted-destructive"
        size="icon-sm"
        disabled={isClosing || props.unavailable}
        aria-label={closeLabel}
        data-testid={`switcher-browser-close-${tab.tabId}`}
        className="shrink-0"
        onClick={close}
      >
        {isClosing ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
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
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { row, tabId, onClose } = props;
  const drivers = useCoalescedBrowserTabDrivers(row.tab.drivenBy);
  const { chatById } = props;
  const { openTile } = useEpicTileNavigation();
  const driver = drivers.length === 0 ? null : drivers[0];
  const chat = driver === null ? undefined : chatById.get(driver.chatId);
  // No find-then-focus branch: `dedupe` focuses an already-open instance of
  // this exact ref (content id AND host) and only opens when there is none.
  const onSelect = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (chat === undefined) return;
      openTile({
        node: makeOpenableNodeRef({
          id: chat.id,
          instanceId: crypto.randomUUID(),
          type: "chat",
          name: chat.title,
          hostId: row.session.hostId,
        }),
        target: { tabId },
        gesture: "explicit",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
      onClose();
    },
    [chat, onClose, openTile, row.session.hostId, tabId],
  );
  // A driver whose chat this epic's records cannot resolve has nowhere to jump
  // to, so it stays a state the row reports rather than an action it offers.
  if (chat === undefined) return null;
  const names = browserTabDriverNames(drivers, chatById);
  return (
    <Button
      type="button"
      variant="info-ghost"
      size="icon-sm"
      aria-label={`Open driving chat: ${names.join(", ")}`}
      data-testid={`switcher-browser-driver-${row.tab.tabId}`}
      className="shrink-0"
      onClick={onSelect}
    >
      <Bot className="size-4" aria-hidden />
    </Button>
  );
}
