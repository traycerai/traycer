import { Moon } from "lucide-react";
import { useMemo } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import type { BrowserReplicaTabRow } from "@/components/epic-canvas/sidebar/browser-panel-union";
import { SIDEBAR_REVEAL_HIGHLIGHT_CLASS } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  browserTabFaviconUrl,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
import { cn } from "@/lib/utils";
import { browserSessionTileId } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useIsActiveTile } from "@/stores/epics/canvas/store";

/**
 * A tab of a session on another of the person's machines. Opening it dials
 * that machine, like any tile on a host other than this one. While the machine
 * is offline the row shows asleep and an open is refused instead.
 *
 * No close and no driver mark: both are the live stream's, and the machine
 * that runs the session is the only one that has it.
 */
export function BrowserReplicaTabRowView(props: {
  readonly viewTabId: string;
  readonly row: BrowserReplicaTabRow;
  readonly secondaryLabel: string | null;
  readonly machineLabel: string;
  readonly offline: boolean;
  readonly onOpen: (row: BrowserReplicaTabRow, permanently: boolean) => void;
  readonly onRefuse: (machineLabel: string) => void;
}) {
  const { row, offline } = props;
  const title = resolveTabTitle(row.tab);
  const tileId = useMemo(
    () =>
      browserSessionTileId({
        sessionId: row.replica.sessionId,
        tabId: row.tab.tabId,
      }),
    [row.replica.sessionId, row.tab.tabId],
  );
  const isActive = useIsActiveTile(props.viewTabId, tileId, row.replica.hostId);
  const open = (permanently: boolean): void => {
    if (offline) {
      props.onRefuse(props.machineLabel);
      return;
    }
    props.onOpen(row, permanently);
  };
  const stateLabel = offline ? `, on ${props.machineLabel}, offline` : "";
  return (
    <li>
      <div
        data-active={isActive}
        data-sidebar-node-id={tileId}
        data-testid={`epic-browser-sidebar-replica-row-${row.tab.tabId}`}
        className={cn(
          "group/browser-row relative grid h-8 min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors duration-100 motion-reduce:transition-none",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
          offline && "text-muted-foreground",
          SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
        )}
      >
        <TooltipWrapper
          label={row.tab.url}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            type="button"
            aria-label={`${title}, ${row.tab.url}${stateLabel}`}
            aria-keyshortcuts="Shift+Enter"
            className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 pr-1 text-left text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => open(false)}
            onDoubleClick={() => open(true)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !event.shiftKey) return;
              event.preventDefault();
              open(true);
            }}
          >
            <BrowserFavicon
              faviconUrl={browserTabFaviconUrl(row.tab.url)}
              isolated={row.replica.profile === "isolated"}
              className="size-4"
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {props.secondaryLabel === null ? null : (
                <span className="max-w-[42%] min-w-0 shrink truncate text-ui-xs font-normal text-muted-foreground">
                  {props.secondaryLabel}
                </span>
              )}
            </span>
          </button>
        </TooltipWrapper>
        <span className="flex size-6 items-center justify-center justify-self-center">
          {offline ? (
            <TooltipWrapper
              label={`${props.machineLabel} is offline`}
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
          ) : null}
        </span>
      </div>
    </li>
  );
}
