import type { ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  Bell,
  Check,
  CheckCircle2,
  MessageCircle,
  MessageSquarePlus,
  MessageSquareX,
  Shield,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import {
  FAILURE_TONE,
  notificationFeedTone,
} from "@/components/notifications/notification-indicator-tones";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { notificationPayloadRequiresOriginHost } from "@/hooks/notifications/use-notification-activation";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import {
  classifyProviderPackNotificationLocality,
  presentProviderPackNotificationBody,
  providerPackNotificationAllowsLocalAction,
  providerPackViewingLocalityFromShell,
  type ProviderPackNotificationLocality,
} from "@/lib/notifications/provider-pack-notification-attribution";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
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
  /** Briefly identifies a row that just moved from Attention into Recent. */
  readonly highlightRelocation: boolean;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
  /** Dismiss an unresolved `needs_action` Attention row (stamps `resolvedAt`).
   * Only reached for blocking-tier Attention rows; every other row uses
   * `onAcknowledge`. */
  readonly onResolve: (row: MergedNotificationRow) => void;
}

function isOriginUnavailable(input: {
  readonly row: MergedNotificationRow;
  readonly originStatus: "available" | "unavailable" | undefined;
}): boolean {
  const requiresOriginHost =
    input.row.payload !== null &&
    notificationPayloadRequiresOriginHost(input.row.payload);
  if (!requiresOriginHost) return false;
  if (input.row.originHostId === null) return true;
  return input.originStatus !== "available";
}

/**
 * The motion props the row's `layout` animation needs, or their inert forms.
 *
 * Extracted rather than inlined as four ternaries because this row now carries
 * both the reduced-motion branches and the pack-attribution presentation, and
 * the union of the two pushed `NotificationRow` past the module's complexity
 * ceiling. The reduced-motion answer is one decision, so it reads better as
 * one function than as the same conditional spelled four times.
 */
function rowMotionProps(options: {
  readonly feedId: string;
  readonly shouldReduceMotion: boolean;
}): {
  readonly layout: "position" | false;
  readonly layoutId: string | undefined;
  readonly exit: { readonly opacity: number } | undefined;
} {
  if (options.shouldReduceMotion) {
    return { layout: false, layoutId: undefined, exit: undefined };
  }
  return {
    layout: "position",
    layoutId: `notification-row-${options.feedId}`,
    exit: { opacity: 0 },
  };
}

function isBlockingAttentionRow(row: MergedNotificationRow): boolean {
  const lifecycle = classifyNotificationLifecycle(row);
  return lifecycle.section === "attention" && lifecycle.tier === "blocking";
}

/**
 * One flat, balanced two-line row - a small semantic glyph, title/meta
 * content, trailing relative time, and exactly one primary interactive
 * control. A navigable row's primary control is the row itself (click to
 * activate) with a sibling resolve/mark-as-read affordance while unread; a
 * payload-less row never pretends to navigate - its only control is an
 * explicit acknowledge button, so neither shape ever nests a button inside
 * a button. Unread state is a full-height accent
 * rail on the row's leading edge (matching the app's pre-existing rail
 * language) plus title weight - the rail is absolutely positioned inside a
 * permanently-reserved edge inset (`pl-6` on the row regardless of rail
 * visibility), so its presence never shifts row content. The row itself
 * spans the popover's true edge-to-edge width (no section-level inset) so
 * its bottom divider isn't cut off short of the popover's edges - `pl-6`/
 * `pr-4` reproduce the section inset plus the rail gutter purely as content
 * padding.
 */
export function NotificationRow(props: NotificationRowProps): ReactNode {
  const row = useMergedNotificationRow(props.feedId);
  // Hooks must remain unconditional while an exact-removal frame makes this
  // row disappear between renders.
  const originHost = useHostDirectoryEntry(row?.originHostId ?? "");
  // This machine — not the ambient active host (G8 / D7). Pack-store events
  // are machine-local; comparing against active would mis-caption when the
  // user has a remote host selected.
  const localHost = useReactiveLocalHostEntry();
  const runnerHost = useRunnerHostOrNull();
  const shouldReduceMotion = useReducedMotion() === true;
  if (row === null) return null;

  const packPresentation = resolvePackRowPresentation({
    attribution: row.providerPackAttribution,
    hasLocalHost: runnerHost?.hasLocalHost ?? false,
    localHostId: localHost?.hostId ?? null,
    body: row.body,
    hasPayload: row.payload !== null,
  });
  const isRead = row.readAt !== null;
  const originUnavailable = isOriginUnavailable({
    row,
    originStatus: originHost?.status,
  });
  const isBlockingAttention = isBlockingAttentionRow(row);
  const glyph = notificationRowGlyph(row);
  const Icon = glyph.icon;

  const motionProps = rowMotionProps({
    feedId: row.feedId,
    shouldReduceMotion,
  });

  return (
    <m.li
      layout={motionProps.layout}
      layoutId={motionProps.layoutId}
      exit={motionProps.exit}
      transition={{
        layout: { duration: 0.24, ease: "easeOut" },
        opacity: { duration: 0.12, ease: "easeOut" },
      }}
      // hover:/has-[:focus-visible]: give the whole row a subtle tint
      // whenever any of its interactive controls is hovered or keyboard-
      // focused, so the user can see what they're targeting - distinct from
      // the unread rail, which is a persistent state marker, not a hover
      // affordance (no persistent row tint).
      //
      // Remote pack-store entries stay fully listed (needs_action evidence)
      // but are visually de-emphasised so this machine's actionable items
      // lead — de-emphasis, not filter-out (D7).
      className={cn(
        "relative flex items-start gap-2.5 border-b border-border/60 py-2.5 pr-4 pl-6 last:border-b-0 hover:bg-muted/70 has-[:focus-visible]:bg-muted/70",
        packPresentation.packRemote && "opacity-60",
      )}
      data-testid="notification-entry"
      data-notification-id={row.feedId}
      data-notification-read={isRead ? "true" : "false"}
      data-notification-severity={row.severity}
      data-notification-origin-state={
        originUnavailable ? "unavailable" : "available"
      }
      data-notification-pack-remote={
        packPresentation.packRemote ? "true" : "false"
      }
      data-notification-pack-locality={packPresentation.locality}
    >
      {props.highlightRelocation && !shouldReduceMotion ? (
        <m.span
          aria-hidden
          data-testid="notification-relocation-highlight"
          className="pointer-events-none absolute inset-0 bg-primary/15"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
      ) : null}
      {!isRead ? (
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
      <NotificationRowMain
        row={row}
        displayBody={packPresentation.displayBody}
        isRead={isRead}
        isNavigable={packPresentation.isNavigable}
        originUnavailable={originUnavailable}
        packRemote={packPresentation.packRemote}
        remoteHostLabel={packPresentation.remoteHostLabel}
        onActivate={props.onActivate}
      />
      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        <NotificationTimestamp createdAt={row.createdAt} />
        <NotificationRowTrailingControl
          row={row}
          isNavigable={packPresentation.isNavigable}
          isRead={isRead}
          isBlockingAttention={isBlockingAttention}
          onAcknowledge={props.onAcknowledge}
          onResolve={props.onResolve}
        />
      </div>
    </m.li>
  );
}

function resolvePackRowPresentation(options: {
  readonly attribution: MergedNotificationRow["providerPackAttribution"];
  readonly hasLocalHost: boolean;
  readonly localHostId: string | null;
  readonly body: string;
  readonly hasPayload: boolean;
}): {
  readonly locality: ProviderPackNotificationLocality;
  readonly packRemote: boolean;
  readonly displayBody: string;
  readonly isNavigable: boolean;
  readonly remoteHostLabel: string | null;
} {
  const viewing = providerPackViewingLocalityFromShell({
    hasLocalHost: options.hasLocalHost,
    localHostId: options.localHostId,
  });
  const locality = classifyProviderPackNotificationLocality({
    attribution: options.attribution,
    viewing,
  });
  return {
    locality,
    packRemote: locality === "remote",
    displayBody: presentProviderPackNotificationBody({
      body: options.body,
      attribution: options.attribution,
      locality,
    }),
    isNavigable:
      options.hasPayload && providerPackNotificationAllowsLocalAction(locality),
    remoteHostLabel: options.attribution?.hostLabel ?? null,
  };
}

function NotificationRowMain(props: {
  readonly row: MergedNotificationRow;
  readonly displayBody: string;
  readonly isRead: boolean;
  readonly isNavigable: boolean;
  readonly originUnavailable: boolean;
  readonly packRemote: boolean;
  readonly remoteHostLabel: string | null;
  readonly onActivate: (row: MergedNotificationRow) => void;
}): ReactNode {
  const body = (
    <NotificationRowBody
      title={props.row.title}
      body={props.displayBody}
      isRead={props.isRead}
    />
  );

  if (props.isNavigable && !props.originUnavailable) {
    return (
      <button
        type="button"
        onClick={() => props.onActivate(props.row)}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {body}
      </button>
    );
  }

  const remoteHint =
    props.remoteHostLabel === null
      ? "Act on this from that machine — it cannot be applied here."
      : `Act on this from ${props.remoteHostLabel} — it cannot be applied here.`;

  return (
    <div className="min-w-0 flex-1">
      {body}
      {props.originUnavailable ? (
        <span
          data-testid="notification-origin-unavailable"
          className="block text-ui-xs text-muted-foreground"
        >
          The originating host is unavailable.
        </span>
      ) : null}
      {props.packRemote ? (
        <span
          data-testid="notification-pack-remote-hint"
          className="block text-ui-xs text-muted-foreground"
        >
          {remoteHint}
        </span>
      ) : null}
    </div>
  );
}

interface NotificationRowTrailingControlProps {
  readonly row: MergedNotificationRow;
  readonly isNavigable: boolean;
  readonly isRead: boolean;
  readonly isBlockingAttention: boolean;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
  readonly onResolve: (row: MergedNotificationRow) => void;
}

/** The sibling trailing control. On an unresolved `needs_action` Attention row
 * it is a "Dismiss" affordance - the same right-edge tick normal rows carry,
 * but wired to `onResolve` (which stamps `resolvedAt`) so the row leaves
 * Attention without answering the underlying prompt. Every other row keeps
 * the original acknowledge control - "Mark as read" on a navigable row or
 * "Acknowledge" on a payload-less one. All variants are shown only while
 * unread: a read row has nothing left to press, and reusing the tick for
 * another disposition makes the read-state affordance ambiguous. */
function NotificationRowTrailingControl(
  props: NotificationRowTrailingControlProps,
): ReactNode {
  if (props.isRead) return null;
  if (props.isBlockingAttention) {
    return (
      <NotificationRowControlButton
        label="Dismiss"
        testId="notification-dismiss"
        onClick={() => props.onResolve(props.row)}
      />
    );
  }
  return (
    <NotificationRowControlButton
      label={props.isNavigable ? "Mark as read" : "Acknowledge"}
      testId={
        props.isNavigable
          ? "notification-mark-read"
          : "notification-acknowledge"
      }
      onClick={() => props.onAcknowledge(props.row)}
    />
  );
}

interface NotificationRowControlButtonProps {
  readonly label: string;
  readonly testId: string;
  readonly onClick: () => void;
}

/** The shared right-edge tick button. Dismiss / mark-as-read / acknowledge are
 * the same affordance visually (same icon, size, and styling / testid family);
 * only the label, testid, and click target differ. It is a sibling of the
 * navigable body button, never nested inside it, so a click can't activate the
 * row. */
function NotificationRowControlButton(
  props: NotificationRowControlButtonProps,
): ReactNode {
  return (
    <TooltipWrapper
      label={props.label}
      side="left"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        onClick={props.onClick}
        aria-label={props.label}
        data-testid={props.testId}
        className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Check className="size-3.5" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

interface NotificationRowBodyProps {
  readonly title: string;
  readonly body: string;
  readonly isRead: boolean;
}

function NotificationRowBody(props: NotificationRowBodyProps): ReactNode {
  const { title, body, isRead } = props;
  const { ref: titleRef, isTruncated } =
    useIsTextTruncated<HTMLSpanElement>(title);
  return (
    <>
      <TooltipWrapper
        label={isTruncated ? title : null}
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
          {title}
        </span>
      </TooltipWrapper>
      <span
        data-testid="notification-body"
        className="block truncate text-ui-xs text-muted-foreground"
      >
        {body}
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

const FAILURE_COLOR = "text-destructive";
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
    return {
      icon: FAILURE_TONE.Icon,
      colorClassName: FAILURE_TONE.className,
    };
  }
  const statusTone = notificationFeedTone(row);
  if (statusTone !== null) {
    return { icon: statusTone.Icon, colorClassName: statusTone.className };
  }
  switch (row.hostKind) {
    case "agent.stopped":
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
    case "agent.stalled":
      return { icon: MessageSquareX, colorClassName: FAILURE_COLOR };
    case "approval.requested":
    case "interview.requested":
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
    case "workspace.operation.failed":
      return { icon: MessageSquareX, colorClassName: FAILURE_COLOR };
    // Only reachable for an `info` row: the severity branches above already
    // claim every `done`/`failure`/`needs_action` host-operation row, and the
    // kind itself says nothing about how the operation ended.
    case "host.operation.finished":
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
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
