import { useDraggable } from "@dnd-kit/core";
import { Bot, Moon, TriangleAlert, X } from "lucide-react";
import { useMemo } from "react";
import type {
  BrowserSessionInfo,
  BrowserTabDriver,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import {
  BROWSER_TILE_DND_TYPE,
  getBrowserTileDragId,
  getPaneScopedDndId,
  type EpicCanvasBrowserTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { browserTabDriverNames } from "@/components/epic-canvas/sidebar/browser-driver-coalescing";
import { useCoalescedBrowserTabDrivers } from "@/components/epic-canvas/sidebar/use-coalesced-browser-tab-drivers";
import {
  browserTabCloseLabel,
  useBrowserTabClose,
} from "@/components/epic-canvas/sidebar/use-browser-tab-close";
import {
  browserTabOrigin,
  type SettledTabIdentity,
} from "@/lib/browser-view/browser-tab-display";
import { cn } from "@/lib/utils";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";

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

export function BrowserTabRow(props: BrowserTabRowProps) {
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
  const visibleDrivers = useCoalescedBrowserTabDrivers(tab.drivenBy);
  const { isClosing, close: handleClose } = useBrowserTabClose({
    epicId,
    viewTabId,
    hostId: session.hostId,
    sessionId: session.sessionId,
    tabId: tab.tabId,
    title,
    status: tab.status,
    onCloseTab,
  });
  const closeAriaLabel = browserTabCloseLabel({
    tabId: tab.tabId,
    title,
    secondaryLabel,
    isDuplicateTitle: duplicateTitles.has(title),
    isClosing,
  });
  const tile = useMemo(
    () =>
      makeBrowserSessionTileRef({
        hostId: session.hostId,
        sessionId: session.sessionId,
        tabId: tab.tabId,
      }),
    [session.hostId, session.sessionId, tab.tabId],
  );
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
          "group/browser-row relative grid h-8 min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center rounded-md transition-colors duration-100 motion-reduce:transition-none",
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
          aria-label={closeAriaLabel}
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
    const names = browserTabDriverNames(props.drivers, props.chatById);
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
