import { useCallback, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  CircleAlert,
  MessageCircle,
  MessageSquarePlus,
  MessageSquareX,
  Settings,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  type MergedNotificationRow,
  useMergedNotificationIds,
  useMergedNotificationRow,
  useMergedNotificationUnreadCount,
  useMergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import {
  type NotificationEvent,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";

interface NotificationsPopoverProps {
  readonly onNavigate: () => void;
}

type NotificationsTab = "unread" | "all";

/**
 * Notifications list surface. Rendered inside the bell's popover.
 *
 * Layout: header with unread count, unread/all tabs, and bulk actions. Every
 * row is a single button (navigation), with a sibling hover-revealed
 * "mark as read" affordance - no nested buttons.
 *
 * Click-to-navigate: clicking a notification activates it through the same
 * preflight path that `NotificationFocusBridge` uses for OS-toast clicks.
 * Feed entries are marked read only after activation succeeds.
 */
export function NotificationsPopover(props: NotificationsPopoverProps) {
  const { onNavigate } = props;
  const ids = useMergedNotificationIds();
  const actions = useMergedNotificationsActions();
  const { activate } = useNotificationActivation();
  const { openSettings } = useSystemTabModalActions();
  const [activeTab, setActiveTab] = useState<NotificationsTab>("unread");

  const handleClick = useCallback(
    (row: MergedNotificationRow) => {
      if (row.payload === null) {
        actions.markAsRead(row.feedId);
        return;
      }
      onNavigate();
      activate({
        payload: row.payload,
        receivedAt: Date.now(),
        onActivated: () => {
          actions.markAsRead(row.feedId);
        },
      });
    },
    [actions, activate, onNavigate],
  );

  const handleTabChange = useCallback((value: string) => {
    if (isNotificationsTab(value)) {
      setActiveTab(value);
    }
  }, []);

  const handleOpenSettings = useCallback(() => {
    onNavigate();
    openSettings({ section: "notifications", resetToGeneral: false });
  }, [onNavigate, openSettings]);

  const isEmpty = ids.length === 0;
  const unreadCount = useMergedNotificationUnreadCount();

  return (
    <TooltipProvider delayDuration={300}>
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex h-[min(var(--radix-popover-content-available-height,70vh),32rem)] w-[min(90vw,24rem)] min-w-0 flex-col gap-0 overflow-hidden"
        data-testid="notifications-popover"
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-border/60 bg-popover px-4 pt-3 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-ui-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <Badge
                variant="destructive"
                className="h-5 min-w-5 px-1.5 text-overline tabular-nums"
                data-testid="notifications-unread-count"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <TabsList variant="line" className="h-7 shrink min-w-0 gap-3 p-0">
              <TabsTrigger
                value="unread"
                data-testid="notifications-tab-unread"
                className="h-7 flex-none px-0 text-ui-xs"
              >
                Unread
                {unreadCount > 0 && (
                  <span className="ml-1 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-overline font-semibold text-destructive tabular-nums">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="all"
                data-testid="notifications-tab-all"
                className="h-7 flex-none px-0 text-ui-xs"
              >
                All
              </TabsTrigger>
            </TabsList>
            <div className="flex shrink-0 items-center gap-1">
              <TooltipWrapper
                label="Mark all as read"
                side="bottom"
                sideOffset={6}
                align="end"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => actions.markAllAsRead()}
                  disabled={unreadCount === 0}
                  data-testid="notifications-mark-all-read"
                  aria-label="Mark all notifications as read"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <CheckCheck className="size-3.5" aria-hidden />
                </Button>
              </TooltipWrapper>
              <TooltipWrapper
                label="Clear all"
                side="bottom"
                sideOffset={6}
                align="end"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => actions.clearAll()}
                  disabled={isEmpty}
                  data-testid="notifications-clear-all"
                  aria-label="Clear all notifications"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </TooltipWrapper>
              <TooltipWrapper
                label="Notification settings"
                side="bottom"
                sideOffset={6}
                align="end"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleOpenSettings}
                  data-testid="notifications-open-settings"
                  aria-label="Open notification settings"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Settings className="size-3.5" aria-hidden />
                </Button>
              </TooltipWrapper>
            </div>
          </div>
        </header>

        <TabsContent
          value="unread"
          data-testid="notifications-tab-content-unread"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain data-[state=inactive]:hidden"
        >
          {unreadCount === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="Unread notifications will appear here."
            />
          ) : (
            <NotificationList
              ids={ids}
              filter="unread"
              onActivate={handleClick}
              onMarkRead={actions.markAsRead}
            />
          )}
        </TabsContent>
        <TabsContent
          value="all"
          data-testid="notifications-tab-content-all"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain data-[state=inactive]:hidden"
        >
          {isEmpty ? (
            <EmptyState
              title="No notifications yet"
              description="New notifications will appear here."
            />
          ) : (
            <NotificationList
              ids={ids}
              filter="all"
              onActivate={handleClick}
              onMarkRead={actions.markAsRead}
            />
          )}
          {activeTab === "all" && actions.canLoadMoreHost ? (
            <div className="border-t border-border/60 p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => actions.loadMoreHost()}
                disabled={actions.isLoadingMoreHost}
                className="w-full text-ui-xs"
              >
                Load older notifications
              </Button>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}

interface NotificationListProps {
  readonly ids: ReadonlyArray<string>;
  readonly filter: NotificationsTab;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onMarkRead: (id: string) => void;
}

function NotificationList(props: NotificationListProps) {
  return (
    <ul className="flex flex-col gap-2 p-2">
      {props.ids.map((id) => (
        <NotificationRow
          key={id}
          feedId={id}
          filter={props.filter}
          onActivate={props.onActivate}
          onMarkRead={props.onMarkRead}
        />
      ))}
    </ul>
  );
}

function isNotificationsTab(value: string): value is NotificationsTab {
  return value === "unread" || value === "all";
}

interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
}

function EmptyState(props: EmptyStateProps) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground"
      data-testid="notifications-empty"
    >
      <BellOff className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/60">{props.title}</p>
        <p className="text-ui-xs text-muted-foreground/50">
          {props.description}
        </p>
      </div>
    </div>
  );
}

interface NotificationRowProps {
  readonly feedId: string;
  readonly filter: NotificationsTab;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onMarkRead: (id: string) => void;
}

function NotificationRow(props: NotificationRowProps) {
  const { feedId, filter, onActivate, onMarkRead } = props;
  const row = useMergedNotificationRow(feedId);
  if (row === null) return null;
  const isRead = row.readAt !== null;
  if (filter === "unread" && isRead) return null;
  const meta = getRowMeta(row);
  const Icon = meta.icon;

  return (
    <li
      className={cn(
        "group/row relative overflow-hidden rounded-2xl border border-border/60 bg-muted/35 shadow-sm",
        !isRead && "bg-accent/55",
      )}
      data-testid="notification-entry"
      data-notification-id={row.feedId}
      data-notification-source={row.source}
      data-notification-read={isRead ? "true" : "false"}
      data-notification-severity={row.severity}
      data-notification-outcome={row.outcome ?? "none"}
    >
      {!isRead && (
        <span
          aria-hidden
          data-testid="notification-unread-marker"
          className="pointer-events-none absolute inset-y-2 left-0 z-10 w-1 rounded-r-full bg-blue-500 dark:bg-blue-400"
        />
      )}
      <button
        type="button"
        onClick={() => onActivate(row)}
        aria-label={`${row.title}. ${row.body}`}
        className={cn(
          "flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-colors",
          "hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative grid size-10 shrink-0 place-items-center rounded-xl",
            meta.tone,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <TooltipWrapper
              label={row.title}
              side="bottom"
              sideOffset={6}
              align="start"
            >
              <span
                data-testid="notification-title"
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-sm font-semibold leading-snug",
                  isRead ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {row.title}
              </span>
            </TooltipWrapper>
            <NotificationTimestamp createdAt={row.createdAt} />
          </div>
          <span
            data-testid="notification-body"
            className={cn(
              "truncate text-ui-sm leading-snug",
              isRead ? "text-muted-foreground/80" : "text-foreground/80",
            )}
          >
            {row.body}
          </span>
        </div>
      </button>
      {!isRead && (
        <TooltipWrapper
          label="Mark as read"
          side="left"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onMarkRead(row.feedId);
            }}
            aria-label="Mark as read"
            data-testid="notification-mark-read"
            className={cn(
              "absolute right-2.5 top-2.5 inline-flex size-6 items-center justify-center rounded-md",
              "bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity",
              "hover:bg-background hover:text-foreground",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "group-hover/row:opacity-100",
            )}
          >
            <Check className="size-3.5" aria-hidden />
          </button>
        </TooltipWrapper>
      )}
    </li>
  );
}

interface NotificationTimestampProps {
  readonly createdAt: number;
}

// Isolated leaf so the shared 60s clock only re-renders this span - the
// surrounding row, icon, and button subtree stay still between ticks.
function NotificationTimestamp(props: NotificationTimestampProps) {
  const label = useRelativeTimestamp(props.createdAt);
  return (
    <span
      data-testid="notification-timestamp"
      className="text-ui-xs text-muted-foreground"
    >
      {label}
    </span>
  );
}

interface EventMeta {
  readonly icon: LucideIcon;
  /** Tailwind classes for the icon-circle background + foreground tone. */
  readonly tone: string;
}

const INVITE_TONE =
  "bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-[color-mix(in_oklch,var(--primary)_55%,var(--foreground)_45%)]";
const DANGER_TONE =
  "bg-[color-mix(in_oklch,var(--destructive)_16%,transparent)] text-[color-mix(in_oklch,var(--destructive)_65%,var(--foreground)_35%)]";
const PROMPT_TONE = "bg-amber-500/16 text-amber-600 dark:text-amber-400";
const DONE_TONE = "bg-blue-500/16 text-blue-700 dark:text-blue-300";
const NEUTRAL_TONE =
  "bg-[color-mix(in_oklch,var(--muted-foreground)_14%,transparent)] text-[color-mix(in_oklch,var(--muted-foreground)_70%,var(--foreground)_30%)]";
const SUCCESS_TONE =
  "bg-[color-mix(in_oklch,var(--success)_16%,transparent)] text-[color-mix(in_oklch,var(--success)_65%,var(--foreground)_35%)]";

function getRowMeta(row: MergedNotificationRow): EventMeta {
  if (row.globalEntry !== null) {
    return getGlobalEventMeta(row.globalEntry.event);
  }
  if (row.appLocalKind !== null) {
    return {
      icon: CircleAlert,
      tone: DANGER_TONE,
    };
  }
  if (row.severity === "failure") {
    return {
      icon: CircleAlert,
      tone: DANGER_TONE,
    };
  }
  if (row.severity === "needs_action") {
    return {
      icon: row.hostKind === "approval.requested" ? Shield : MessageCircle,
      tone: PROMPT_TONE,
    };
  }
  if (row.severity === "done") {
    return {
      icon: Bell,
      tone: DONE_TONE,
    };
  }
  switch (row.hostKind) {
    case "agent.stopped":
      return {
        icon: Bell,
        tone: DONE_TONE,
      };
    case "agent.stalled":
      return {
        icon: CircleAlert,
        tone: DANGER_TONE,
      };
    case "approval.requested":
      return {
        icon: Shield,
        tone: PROMPT_TONE,
      };
    case "interview.requested":
      return {
        icon: MessageCircle,
        tone: PROMPT_TONE,
      };
    case null:
      return {
        icon: Bell,
        tone: NEUTRAL_TONE,
      };
  }
}

function getGlobalEventMeta(event: NotificationEvent): EventMeta {
  switch (event.kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED:
      return {
        icon: UserPlus,
        tone: INVITE_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED:
      return {
        icon: Shield,
        tone: INVITE_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.REVOKED:
      return {
        icon: UserMinus,
        tone: DANGER_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED:
      return {
        icon: MessageSquarePlus,
        tone: NEUTRAL_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED:
      return {
        icon: MessageCircle,
        tone: NEUTRAL_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED:
      return {
        icon: CheckCircle2,
        tone: SUCCESS_TONE,
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED:
      return {
        icon: MessageSquareX,
        tone: DANGER_TONE,
      };
    default:
      // Fall through to a safe neutral fallback. The previous
      // `const _exhaustive: never = event; return _exhaustive` form was a
      // compile-time exhaustiveness assertion, but at runtime it returned
      // the raw event object - which would crash the renderer the moment
      // the server shipped a new event kind before a client upgrade.
      return {
        icon: Bell,
        tone: NEUTRAL_TONE,
      };
  }
}
