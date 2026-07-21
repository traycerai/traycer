import type { ReactNode } from "react";
import {
  Bell,
  Check,
  CheckCircle2,
  CircleAlert,
  MessageCircle,
  MessageSquarePlus,
  MessageSquareX,
  Shield,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  type MergedNotificationRow,
  useMergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import {
  type NotificationEvent,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";

interface NotificationRowProps {
  readonly feedId: string;
  /** True while this exact row is mid-activation (routed, awaiting host
   * preflight). Only the activating row is ever pending - every other row
   * stays fully interactive. Disabling here never changes the row's DOM
   * structure/size, so the T04 frozen-geometry outer rect holds across
   * pending/failure transitions. */
  readonly isPending: boolean;
  /** Attention rows always carry the rail, regardless of read state - an
   * unresolved prompt must keep drawing the eye even after activation marks
   * it read (needs_action attention membership is keyed on `resolvedAt`,
   * not `readAt` - see `classifyNotificationLifecycle`). Recent rows pass
   * `false` and fall back to the unread-only rule. */
  readonly alwaysShowRail: boolean;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/**
 * One flat, balanced two-line row - a small semantic glyph, title/meta
 * content, trailing relative time, and exactly one primary interactive
 * control. A navigable row's primary control is the row itself (click to
 * activate) with a sibling "mark as read" affordance while unread; a
 * payload-less row never pretends to navigate - its only control is an
 * explicit acknowledge button, so neither shape ever nests a button inside
 * a button. Unread state (or Attention membership) is a full-height accent
 * rail on the row's leading edge (matching the app's pre-existing rail
 * language) plus title weight - the rail is absolutely positioned inside a
 * permanently-reserved edge inset (`pl-6` on the row regardless of rail
 * visibility), so its presence never shifts row content. The row itself
 * spans the popover's true edge-to-edge width (no section-level inset) so
 * its bottom divider isn't cut off short of the popover's edges - `pl-6`/
 * `pr-4` reproduce the old section inset (px-4) plus the rail gutter purely
 * as content padding.
 */
export function NotificationRow(props: NotificationRowProps): ReactNode {
  const row = useMergedNotificationRow(props.feedId);
  if (row === null) return null;
  const isRead = row.readAt !== null;
  const isNavigable = row.payload !== null;
  const isPending = props.isPending;
  const showRail = props.alwaysShowRail || !isRead;
  const glyph = notificationRowGlyph(row);
  const Icon = glyph.icon;

  return (
    <li
      // hover:/has-[:focus-visible]: give the whole row a subtle tint
      // whenever any of its interactive controls is hovered or keyboard-
      // focused, so the user can see what they're targeting - distinct from
      // the unread rail, which is a persistent state marker, not a hover
      // affordance (no persistent row tint).
      className="relative flex items-start gap-2.5 border-b border-border/60 py-2.5 pr-4 pl-6 last:border-b-0 hover:bg-muted/70 has-[:focus-visible]:bg-muted/70"
      data-testid="notification-entry"
      data-notification-id={row.feedId}
      data-notification-read={isRead ? "true" : "false"}
      data-notification-severity={row.severity}
      data-notification-pending={isPending ? "true" : "false"}
    >
      {showRail ? (
        <span
          aria-hidden
          data-testid="notification-unread-rail"
          className="absolute inset-y-0 left-0 w-0.5 bg-primary"
        />
      ) : null}
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center"
      >
        <Icon className={cn("size-4", glyph.colorClassName)} />
      </span>
      {isNavigable ? (
        <button
          type="button"
          onClick={() => props.onActivate(row)}
          disabled={isPending}
          aria-busy={isPending}
          className={cn(
            "min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            isPending && "pointer-events-none opacity-60",
          )}
        >
          <NotificationRowBody row={row} isRead={isRead} />
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <NotificationRowBody row={row} isRead={isRead} />
        </div>
      )}
      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        <NotificationTimestamp createdAt={row.createdAt} />
        <NotificationRowAcknowledgeControl
          row={row}
          isNavigable={isNavigable}
          isRead={isRead}
          isPending={isPending}
          onAcknowledge={props.onAcknowledge}
        />
      </div>
    </li>
  );
}

interface NotificationRowAcknowledgeControlProps {
  readonly row: MergedNotificationRow;
  readonly isNavigable: boolean;
  readonly isRead: boolean;
  readonly isPending: boolean;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/** The sibling acknowledge control for both row shapes - "mark as read" on a
 * navigable row, "acknowledge" (the only control) on a payload-less one.
 * Once read, the control disappears entirely rather than lingering as a
 * disabled button: a row that's already been acknowledged has nothing left
 * to press, and a dead-looking (grayed, unclickable) control read as broken
 * rather than done. */
function NotificationRowAcknowledgeControl(
  props: NotificationRowAcknowledgeControlProps,
): ReactNode {
  if (props.isRead) return null;
  const label = props.isNavigable ? "Mark as read" : "Acknowledge";
  return (
    <TooltipWrapper
      label={label}
      side="left"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        onClick={() => props.onAcknowledge(props.row)}
        disabled={props.isPending}
        aria-label={label}
        data-testid={
          props.isNavigable
            ? "notification-mark-read"
            : "notification-acknowledge"
        }
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          props.isPending && "pointer-events-none opacity-60",
        )}
      >
        <Check className="size-3.5" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

interface NotificationRowBodyProps {
  readonly row: MergedNotificationRow;
  readonly isRead: boolean;
}

function NotificationRowBody(props: NotificationRowBodyProps): ReactNode {
  const { row, isRead } = props;
  const { ref: titleRef, isTruncated } = useIsTextTruncated<HTMLSpanElement>(
    row.title,
  );
  return (
    <>
      <TooltipWrapper
        label={isTruncated ? row.title : null}
        side="bottom"
        sideOffset={6}
        align="start"
      >
        <span
          ref={titleRef}
          data-testid="notification-title"
          className={cn(
            "block truncate text-ui-sm leading-snug",
            isRead
              ? "font-medium text-foreground/85"
              : "font-semibold text-foreground",
          )}
        >
          {row.title}
        </span>
      </TooltipWrapper>
      <span
        data-testid="notification-body"
        className="block truncate text-ui-xs text-muted-foreground"
      >
        {row.body}
      </span>
    </>
  );
}

interface NotificationTimestampProps {
  readonly createdAt: number;
}

// Isolated leaf so the shared 60s clock only re-renders this span - the
// surrounding row, glyph, and button subtree stay still between ticks (and,
// critically, never touch the frozen outer shell dimensions).
function NotificationTimestamp(props: NotificationTimestampProps): ReactNode {
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

interface RowGlyph {
  readonly icon: LucideIcon;
  readonly colorClassName: string;
}

const PROMPT_COLOR = "text-amber-600 dark:text-amber-400";
const FAILURE_COLOR = "text-destructive";
const DONE_COLOR = "text-blue-600 dark:text-blue-400";
const NEUTRAL_COLOR = "text-muted-foreground";
const SUCCESS_COLOR = "text-success-foreground";
const INVITE_COLOR = "text-primary";

/** Severity/category glyph selection - color is the only severity signal
 * (no background tint, no icon-tile), matching the approved flat visual
 * contract. */
function notificationRowGlyph(row: MergedNotificationRow): RowGlyph {
  if (row.globalEntry !== null) {
    return globalEventGlyph(row.globalEntry.event);
  }
  if (row.appLocalKind !== null) {
    return { icon: CircleAlert, colorClassName: FAILURE_COLOR };
  }
  if (row.severity === "failure") {
    return { icon: CircleAlert, colorClassName: FAILURE_COLOR };
  }
  if (row.severity === "needs_action") {
    return {
      icon: row.hostKind === "approval.requested" ? Shield : MessageCircle,
      colorClassName: PROMPT_COLOR,
    };
  }
  if (row.severity === "done") {
    return { icon: Bell, colorClassName: DONE_COLOR };
  }
  switch (row.hostKind) {
    case "agent.stopped":
      return { icon: Bell, colorClassName: DONE_COLOR };
    case "agent.stalled":
      return { icon: CircleAlert, colorClassName: FAILURE_COLOR };
    case "approval.requested":
      return { icon: Shield, colorClassName: PROMPT_COLOR };
    case "interview.requested":
      return { icon: MessageCircle, colorClassName: PROMPT_COLOR };
    case "workspace.operation.failed":
      return { icon: CircleAlert, colorClassName: FAILURE_COLOR };
    case null:
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
  }
}

function globalEventGlyph(event: NotificationEvent): RowGlyph {
  switch (event.kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED:
      return { icon: UserPlus, colorClassName: INVITE_COLOR };
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED:
      return { icon: Shield, colorClassName: INVITE_COLOR };
    case NOTIFICATION_EVENT_TYPES.REVOKED:
      return { icon: UserMinus, colorClassName: FAILURE_COLOR };
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED:
      return { icon: MessageSquarePlus, colorClassName: NEUTRAL_COLOR };
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED:
      return { icon: MessageCircle, colorClassName: NEUTRAL_COLOR };
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED:
      return { icon: CheckCircle2, colorClassName: SUCCESS_COLOR };
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED:
      return { icon: MessageSquareX, colorClassName: FAILURE_COLOR };
    default:
      // Fall through to a safe neutral fallback rather than an exhaustive
      // `never` assertion - a server-added event kind must degrade, not
      // crash the renderer on a client that hasn't upgraded yet.
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
  }
}
