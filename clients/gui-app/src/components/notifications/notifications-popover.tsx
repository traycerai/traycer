import { useCallback, useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  MessageCircle,
  MessageSquarePlus,
  MessageSquareX,
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
import {
  useNotificationsActions,
  useNotificationsList,
} from "@/hooks/notifications/use-notifications-stream";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { buildPayloadFromEvent } from "@/lib/notifications";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  type NotificationEntry,
  type NotificationEvent,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import { formatNotification } from "@traycer/protocol/notifications/notification-formatter";

interface NotificationsPopoverProps {
  readonly onNavigate: () => void;
}

interface PartitionedEntries {
  readonly unread: ReadonlyArray<NotificationEntry>;
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
  const entries = useNotificationsList();
  const actions = useNotificationsActions();
  const { activate } = useNotificationActivation();
  const [activeTab, setActiveTab] = useState<NotificationsTab>("unread");

  const partitioned = useMemo<PartitionedEntries>(
    () => ({ unread: entries.filter((entry) => entry.readAt === null) }),
    [entries],
  );

  const handleClick = useCallback(
    (entry: NotificationEntry) => {
      const payload = buildPayloadFromEvent(entry.event);
      onNavigate();
      activate({
        payload,
        receivedAt: Date.now(),
        onActivated: () => {
          actions.markAsRead(entry.id);
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

  const isEmpty = entries.length === 0;
  const unreadCount = partitioned.unread.length;

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
            </div>
          </div>
        </header>

        <TabsContent
          value="unread"
          data-testid="notifications-tab-content-unread"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain data-[state=inactive]:hidden"
        >
          {partitioned.unread.length === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="Unread notifications will appear here."
            />
          ) : (
            <NotificationList
              entries={partitioned.unread}
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
              entries={entries}
              onActivate={handleClick}
              onMarkRead={actions.markAsRead}
            />
          )}
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}

interface NotificationListProps {
  readonly entries: ReadonlyArray<NotificationEntry>;
  readonly onActivate: (entry: NotificationEntry) => void;
  readonly onMarkRead: (id: string) => void;
}

function NotificationList(props: NotificationListProps) {
  return (
    <ul className="flex flex-col py-1">
      {props.entries.map((entry) => (
        <NotificationRow
          key={entry.id}
          entry={entry}
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
  readonly entry: NotificationEntry;
  readonly onActivate: (entry: NotificationEntry) => void;
  readonly onMarkRead: (id: string) => void;
}

function NotificationRow(props: NotificationRowProps) {
  const { entry, onActivate, onMarkRead } = props;
  const isRead = entry.readAt !== null;
  const text = formatNotification(entry.event, undefined);
  const meta = getEventMeta(entry.event);
  const Icon = meta.icon;

  return (
    <li
      className="group/row relative"
      data-testid="notification-entry"
      data-notification-id={entry.id}
      data-notification-read={isRead ? "true" : "false"}
    >
      {!isRead && (
        <span
          aria-hidden
          data-testid="notification-unread-marker"
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 rounded-r-full bg-blue-500 dark:bg-blue-400"
        />
      )}
      <button
        type="button"
        onClick={() => onActivate(entry)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors",
          "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          !isRead && "bg-accent/30",
        )}
      >
        <span aria-hidden className="mt-1.5 h-4 w-0.5 shrink-0" />
        <span
          aria-hidden
          className={cn(
            "relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
            meta.tone,
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-7">
          <span
            className={cn(
              "line-clamp-2 text-ui-sm leading-snug",
              isRead ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {text}
          </span>
          <NotificationTimestamp createdAt={entry.createdAt} />
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
              onMarkRead(entry.id);
            }}
            aria-label="Mark as read"
            data-testid="notification-mark-read"
            className={cn(
              "absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-md",
              "text-muted-foreground opacity-0 transition-opacity",
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
const NEUTRAL_TONE =
  "bg-[color-mix(in_oklch,var(--muted-foreground)_14%,transparent)] text-[color-mix(in_oklch,var(--muted-foreground)_70%,var(--foreground)_30%)]";
const SUCCESS_TONE =
  "bg-[color-mix(in_oklch,var(--success)_16%,transparent)] text-[color-mix(in_oklch,var(--success)_65%,var(--foreground)_35%)]";

function getEventMeta(event: NotificationEvent): EventMeta {
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
