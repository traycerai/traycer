import type { ComponentPropsWithRef, ReactNode } from "react";
import { Bell, History, Plus } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
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
import { useNeedsYouTaskCount } from "@/stores/notifications/needs-you-task-count-store";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import {
  useSystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";
import type { SideTabRowVariant } from "./side-tab-row";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
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
 * New Task (F7): the button that closes the nav list - after Home
 * expanded, after All tasks on the rail - and does what the header's `+` does.
 * Expanded, a row lined up with the nav rows, its shortcut trailing as All
 * tasks' does; collapsed, a primary 32px tile. Solid primary in every view:
 * the strip always keeps one primary action.
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
  const content = (
    <>
      <Plus
        aria-hidden
        className={cn(SIDE_TAB_LEADING_CLASS, collapsed && "me-0", "shrink-0")}
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
            <span
              className={cn(
                "shrink-0 text-ui-xs",
                "font-normal text-primary-foreground/70",
              )}
            >
              {shortcut}
            </span>
          )}
        </>
      )}
    </>
  );
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
        {content}
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
export function NavRowButton(
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
    setOpen,
    bellState,
    chord,
    triggerRef,
    onTriggerPointerDown,
    onTriggerKeyDown,
    contentHandlers,
    popoverProps,
  } = useNotificationCenter();
  // Tasks, as the Needs you header counts them; the drawer lists requests.
  const needsYouCount = useNeedsYouTaskCount();
  const unreadCount = useMergedNotificationUnreadCount();
  // The Activity view's To review lists what else there is, so its pill is
  // the Needs you count alone; the Layered view's says the rest as the bell
  // does.
  const needsYouOnly = useLiveAgentsInStrip();
  const pill = inboxPillOf({
    needsYou: needsYouCount,
    attention: bellState.kind === "attention" ? bellState.count : 0,
    unread: unreadCount,
    needsYouOnly,
  });
  // The bell's `unknown`: a summary is unavailable, so zero counts are not a
  // claim that nothing is waiting (see `useNotificationBellState`).
  const unavailable = bellState.kind === "unknown";
  const tooltip = inboxTooltip(unavailable, chord);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={(collapsed || unavailable) && !open ? tooltip : null}
        side={placement?.side ?? "right"}
        sideOffset={6}
        align={placement?.align}
      >
        <PopoverTrigger asChild>
          <NavRowButton
            ref={triggerRef}
            variant={props.variant}
            active={open}
            aria-label={inboxAccessibleLabel(
              needsYouCount,
              pill?.tone === "attention" ? pill.count : 0,
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
                {pill === null ? null : (
                  <Badge
                    variant={INBOX_PILL_VARIANT[pill.tone]}
                    size="sm"
                    aria-hidden
                    data-testid="side-strip-inbox-count"
                    data-tone={pill.tone}
                    data-needs-you={pill.tone === "needs-you"}
                  >
                    <span className="tabular-nums">{pill.count}</span>
                  </Badge>
                )}
                {/* Only where no count is drawn, as on the tile: a zero with
                    no summary behind it is the claim the dot exists to
                    qualify. Beside a count it said nothing the tooltip and
                    the row's name do not. */}
                {unavailable && pill === null ? (
                  <span
                    aria-hidden
                    data-testid="side-strip-inbox-unknown-indicator"
                    className={cn(INBOX_UNKNOWN_DOT_CLASS, "shrink-0")}
                  />
                ) : null}
              </>
            )}
          </NavRowButton>
        </PopoverTrigger>
      </TooltipWrapper>
      {/* The drawer hangs off the whole strip column, not off this row: the
          anchor fills the strip's `relative` nav, the nearest positioned
          ancestor, so the drawer's top and height follow the strip's.
          AFTER the trigger, not before it: Radix reports an anchor only when
          it changes, so on the first commit the last one in tree order wins,
          and the trigger's own is dropped (and its button remounted) on the
          next. Placed first, the drawer measured that detached button: 0x0 at
          the window's corner. */}
      <PopoverAnchor asChild>
        <span
          aria-hidden
          data-testid="inbox-drawer-anchor"
          className="pointer-events-none absolute inset-0"
        />
      </PopoverAnchor>
      <PopoverContent
        layout="bare"
        side={placement?.side}
        align="start"
        // Flush surface: the strip and the frame sit with no ground between
        // them any more, so the drawer opens flush off the strip too, level
        // with the frame's own top and bottom.
        sideOffset={0}
        alignOffset={0}
        data-testid="side-strip-inbox-drawer"
        className="h-[var(--radix-popover-trigger-height)] w-auto overflow-hidden"
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

/** What the Notifications pill's one count says, which its colour names. */
type InboxPillTone = "needs-you" | "attention" | "unread";

const INBOX_PILL_VARIANT: Readonly<
  Record<InboxPillTone, "warning" | "destructive" | "muted">
> = { "needs-you": "warning", attention: "destructive", unread: "muted" };

/**
 * The Notifications row's one count, as the header's bell picks its mark:
 * amber, the Needs you task count, while a task needs the person; else red,
 * what needs attention, failures among it; else muted, the unread total. The
 * Activity view shows the amber count alone. `null` with nothing to count.
 */
function inboxPillOf(input: {
  readonly needsYou: number;
  readonly attention: number;
  readonly unread: number;
  readonly needsYouOnly: boolean;
}): { readonly tone: InboxPillTone; readonly count: number } | null {
  if (input.needsYou > 0) return { tone: "needs-you", count: input.needsYou };
  if (input.needsYouOnly) return null;
  if (input.attention > 0) return { tone: "attention", count: input.attention };
  return input.unread > 0 ? { tone: "unread", count: input.unread } : null;
}

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
  attention: number,
  unread: number,
  unavailable: boolean,
): string {
  const parts = [
    needsYou > 0 ? `${needsYou} need you` : null,
    attention > 0 ? `${attention} need attention` : null,
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
