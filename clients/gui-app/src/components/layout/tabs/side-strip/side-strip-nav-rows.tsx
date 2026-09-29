import { useRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { Bell, History, Plus } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useNotificationCenter } from "@/hooks/notifications/use-notification-center";
import {
  formatChordForDisplay,
  type ChordString,
} from "@/lib/keybindings/chord";
import { cn } from "@/lib/utils";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import { useMergedNotificationUnreadCount } from "@/stores/notifications/merged-notifications";
import { useNeedsYouItems } from "@/stores/notifications/needs-you-items";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import {
  useSystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_NAV_TILE_CLASS,
  SIDE_STRIP_NAV_TILE_COUNT_CLASS,
  SIDE_STRIP_NAV_TILE_UNKNOWN_DOT_CLASS,
  SIDE_STRIP_SECTION_LABEL_CLASS,
  SIDE_TAB_ACTIVE_CLASS,
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_LEADING_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "./side-strip-tokens";

/**
 * The strip's nav rows under the top block's controls (D6): Notifications, which
 * opens the notification center as a drawer on the strip's edge, and All
 * tasks, which opens History. Collapsed, both are 32px icon tiles.
 */
export function SideStripNavRows(props: {
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const admitted = useAuthStore((state) => admitsLocalPlane(state.status));
  return (
    <>
      {/* The notification centre is a local-plane surface; see
          `HeaderNotificationsBell` for why the gate is not "signed in". */}
      {admitted ? <InboxNavRow variant={props.variant} /> : null}
      <AllTasksNavRow variant={props.variant} />
    </>
  );
}

/**
 * New Task (F7): the primary button that closes the nav list - after Home
 * expanded, after All tasks on the rail - and does what the header's `+` does.
 * Expanded, a row lined up with the nav rows, its shortcut trailing as All
 * tasks' does; collapsed, a primary 32px tile.
 */
export function SideStripNewTask(props: {
  readonly variant: SideTabRowVariant;
  readonly onNewTab: () => void;
}): ReactNode {
  const collapsed = props.variant === "collapsed";
  const placement = useColumnOverlayPlacement("top");
  const chord = useBindingForAction("epic.new");
  const shortcut = chord === null ? null : formatChordForDisplay(chord);
  const tooltip =
    shortcut === null ? NEW_TASK_LABEL : `${NEW_TASK_LABEL} (${shortcut})`;
  return (
    <TooltipWrapper
      label={collapsed ? tooltip : null}
      side={placement?.side ?? "right"}
      sideOffset={6}
      align={placement?.align}
    >
      <Button
        type="button"
        size={collapsed ? "nav-tile" : "nav-row"}
        // Non-editable chrome, dimmed while a layout session is live (4.2).
        data-layout-passive
        data-testid="side-strip-new-task"
        aria-label={collapsed ? NEW_TASK_LABEL : undefined}
        onClick={props.onNewTab}
        className={cn(
          collapsed ? "self-center" : "w-full",
          "[-webkit-app-region:no-drag]",
        )}
      >
        <Plus
          aria-hidden
          className={cn(
            SIDE_TAB_LEADING_CLASS,
            collapsed && "me-0",
            "shrink-0",
          )}
        />
        {collapsed ? null : (
          <>
            <span
              data-testid="side-strip-new-task-label"
              className={cn(
                SIDE_TAB_TITLE_CLASS,
                "min-w-0 flex-1 truncate text-left",
              )}
            >
              {NEW_TASK_LABEL}
            </span>
            {shortcut === null ? null : (
              <span className="shrink-0 text-ui-xs font-normal text-primary-foreground/70">
                {shortcut}
              </span>
            )}
          </>
        )}
      </Button>
    </TooltipWrapper>
  );
}

const NEW_TASK_LABEL = "New Task";

/** "Tasks" and the task count, above the task rows (expanded only). */
export function SideStripTasksLabel(props: {
  readonly count: number;
}): ReactNode {
  return (
    <div
      data-testid="side-strip-tasks-label"
      className={cn(
        SIDE_STRIP_SECTION_LABEL_CLASS,
        "flex items-center text-muted-foreground",
      )}
    >
      <span className="min-w-0 flex-1">Tasks</span>
      <span className="tabular-nums">{props.count}</span>
    </div>
  );
}

/** A nav row's element: the expanded row, or the collapsed 32px tile. */
function NavRowButton(
  props: ComponentPropsWithRef<"button"> & {
    readonly variant: SideTabRowVariant;
    readonly active: boolean;
  },
): ReactNode {
  const { variant, active, className, ...buttonProps } = props;
  const collapsed = variant === "collapsed";
  return (
    <button
      type="button"
      data-layout-passive
      data-active={active}
      {...buttonProps}
      className={cn(
        "relative flex shrink-0 items-center text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:text-foreground [-webkit-app-region:no-drag]",
        collapsed
          ? cn(SIDE_STRIP_NAV_TILE_CLASS, "justify-center self-center")
          : cn(SIDE_TAB_ROW_CLASS, "w-full"),
        SIDE_TAB_HOVER_CLASS,
        active && cn(SIDE_TAB_ACTIVE_CLASS, "text-foreground"),
        className,
      )}
    />
  );
}

function InboxNavRow(props: {
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const collapsed = props.variant === "collapsed";
  const placement = useColumnOverlayPlacement("top");
  const {
    open,
    bellState,
    chord,
    triggerRef,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    contentHandlers,
    popoverProps,
  } = useNotificationCenter();
  const drawerAnchorRef = useRef<HTMLSpanElement>(null);
  const needsYouCount = useNeedsYouItems().length;
  const unreadCount = useMergedNotificationUnreadCount();
  // The bell's `unknown`: a summary is unavailable, so zero counts are not a
  // claim that nothing is waiting (see `useNotificationBellState`).
  const unavailable = bellState.kind === "unknown";
  const tooltip = inboxTooltip(unavailable, chord);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <TooltipWrapper
        label={(collapsed || unavailable) && !open ? tooltip : null}
        side={placement?.side ?? "right"}
        sideOffset={6}
        align={placement?.align}
      >
        <PopoverTrigger
          render={
            <NavRowButton
              ref={triggerRef}
              variant={props.variant}
              active={open}
              aria-label={inboxAccessibleLabel(
                needsYouCount,
                unreadCount,
                unavailable,
              )}
              data-testid="side-strip-inbox"
              onPointerDown={onTriggerPointerDown}
              onKeyDown={onTriggerKeyDown}
            >
              <Bell
                className={cn(
                  SIDE_TAB_LEADING_CLASS,
                  collapsed && "me-0",
                  "shrink-0",
                )}
              />
              {collapsed ? (
                <InboxTileMark
                  needsYouCount={needsYouCount}
                  unavailable={unavailable}
                />
              ) : (
                <>
                  <span
                    className={cn(
                      SIDE_TAB_TITLE_CLASS,
                      "min-w-0 flex-1 truncate text-left",
                    )}
                  >
                    Notifications
                  </span>
                  {/* One count, the unread total; a pending ask tints it
                    rather than adding a second number. An ask already read
                    is still pending, so with nothing unread it shows alone. */}
                  {unreadCount > 0 || needsYouCount > 0 ? (
                    <Badge
                      variant={needsYouCount > 0 ? "warning" : "muted"}
                      size="sm"
                      aria-hidden
                      data-testid="side-strip-inbox-count"
                      data-needs-you={needsYouCount > 0}
                    >
                      <span className="tabular-nums">
                        {unreadCount > 0 ? unreadCount : needsYouCount}
                      </span>
                    </Badge>
                  ) : null}
                  {unavailable ? (
                    <span
                      aria-hidden
                      data-testid="side-strip-inbox-unknown-indicator"
                      className={cn(INBOX_UNKNOWN_DOT_CLASS, "shrink-0")}
                    />
                  ) : null}
                </>
              )}
            </NavRowButton>
          }
        />
      </TooltipWrapper>
      {/* The drawer hangs off the whole strip column, not off this row: the
          anchor fills the strip's `relative` nav, the nearest positioned
          ancestor, so the drawer's top and height follow the strip's. */}
      <span
        ref={drawerAnchorRef}
        aria-hidden
        data-testid="inbox-drawer-anchor"
        className="pointer-events-none absolute inset-0"
      />
      <PopoverContent
        layout="bare"
        side={placement?.side}
        align="start"
        // Flush surface: the strip and the frame sit with no ground between
        // them any more, so the drawer opens flush off the strip too, level
        // with the frame's own top and bottom.
        sideOffset={0}
        alignOffset={0}
        anchor={drawerAnchorRef}
        data-testid="side-strip-inbox-drawer"
        className="h-[var(--anchor-height)] w-auto overflow-hidden"
        {...contentHandlers}
      >
        <NotificationsPopover
          variant="inbox"
          {...popoverProps}
          // The drawer's height is the strip's, so the center's one-time
          // size lock has nothing to hold still.
          shellStyle={NO_SHELL_STYLE}
        />
      </PopoverContent>
    </Popover>
  );
}

const NO_SHELL_STYLE = {};

/**
 * The collapsed Notifications tile's corner: the needs-you count, else the
 * status-unavailable dot, else nothing.
 */
function InboxTileMark(props: {
  readonly needsYouCount: number;
  readonly unavailable: boolean;
}): ReactNode {
  if (props.needsYouCount > 0) {
    return (
      <span
        aria-hidden
        data-testid="side-strip-inbox-needs-you-badge"
        className={cn(
          SIDE_STRIP_NAV_TILE_COUNT_CLASS,
          "bg-warning text-center font-semibold text-black tabular-nums",
        )}
      >
        {props.needsYouCount}
      </span>
    );
  }
  if (!props.unavailable) return null;
  return (
    <span
      aria-hidden
      data-testid="side-strip-inbox-unknown-indicator"
      className={cn(
        SIDE_STRIP_NAV_TILE_UNKNOWN_DOT_CLASS,
        INBOX_UNKNOWN_DOT_CLASS,
      )}
    />
  );
}

/**
 * The bell's hollow `unknown` dot: an outline, since a filled dot would claim
 * unread activity (see `NotificationsBell`).
 */
const INBOX_UNKNOWN_DOT_CLASS =
  "size-2 rounded-full border border-muted-foreground/70";

function inboxTooltip(unavailable: boolean, chord: ChordString | null): string {
  if (unavailable) {
    return "Notifications status unavailable, so this may be out of date";
  }
  return chord === null
    ? "Notifications"
    : `Notifications (${formatChordForDisplay(chord)})`;
}

function inboxAccessibleLabel(
  needsYou: number,
  unread: number,
  unavailable: boolean,
): string {
  const parts = [
    needsYou > 0 ? `${needsYou} need you` : null,
    unread > 0 ? `${unread} unread` : null,
    unavailable ? "status unavailable" : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? "Notifications"
    : `Notifications, ${parts.join(", ")}`;
}

/** Opens History, the same action as the header's `HistoryButton`. */
function AllTasksNavRow(props: {
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const collapsed = props.variant === "collapsed";
  const placement = useColumnOverlayPlacement("top");
  const { openHistory } = useSystemTabModalActions();
  const historyOverlayActive = useSystemOverlayActive("history");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = isHistoryPath(pathname) || historyOverlayActive;
  const chord = useBindingForAction("app.history.open");
  const shortcut = chord === null ? null : formatChordForDisplay(chord);
  const tooltip = shortcut === null ? "All tasks" : `All tasks (${shortcut})`;
  return (
    <TooltipWrapper
      label={collapsed ? tooltip : null}
      side={placement?.side ?? "right"}
      sideOffset={6}
      align={placement?.align}
    >
      <NavRowButton
        variant={props.variant}
        active={active}
        aria-label="All tasks"
        aria-haspopup="dialog"
        aria-expanded={active}
        data-testid="side-strip-all-tasks"
        onClick={openHistory}
      >
        <History
          className={cn(
            SIDE_TAB_LEADING_CLASS,
            collapsed && "me-0",
            "shrink-0",
          )}
        />
        {collapsed ? null : (
          <>
            <span
              className={cn(
                SIDE_TAB_TITLE_CLASS,
                "min-w-0 flex-1 truncate text-left",
              )}
            >
              All tasks
            </span>
            {shortcut === null ? null : (
              <span className="shrink-0 text-ui-xs text-muted-foreground">
                {shortcut}
              </span>
            )}
          </>
        )}
      </NavRowButton>
    </TooltipWrapper>
  );
}
