import type { KeyboardEvent, ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  Bell,
  Check,
  CheckCircle2,
  FolderX,
  Globe,
  MessageCircle,
  MessageSquarePlus,
  MessageSquareX,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import {
  FAILURE_TONE,
  notificationFeedTone,
  TERMINAL_FAILURE_TONE,
} from "@/components/notifications/notification-indicator-tones";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostUnavailability,
  isConfirmedTransportRefusal,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { notificationPayloadRequiresOriginHost } from "@/hooks/notifications/use-notification-activation";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
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
  readonly highlightRelocation: boolean;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/** `indeterminate` therefore does not disable - the activation path dials and fails on its own evidence, which
 * is recoverable, where a disabled row is a dead end the user cannot argue with. */
function originRefusal(input: {
  readonly row: MergedNotificationRow;
  readonly originEntry: HostDirectoryEntry | null;
  readonly hasReadySession: boolean;
}): HostUnavailability | null {
  const requiresOriginHost =
    input.row.payload !== null &&
    notificationPayloadRequiresOriginHost(input.row.payload);
  if (!requiresOriginHost) return null;
  if (input.row.originHostId === null) return "offline";
  if (input.originEntry === null) return "offline";
  if (!isConfirmedTransportRefusal(input.originEntry, input.hasReadySession)) {
    return null;
  }
  // Confirmed refusals are exactly `offline` / `plan-restricted`; the verdict
  // read here only picks which copy the row renders.
  return hostUnavailability(input.originEntry);
}

/** The reduced-motion answer is one decision, so it reads better as one function than as the same conditional
 * spelled four times. */
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

/** A navigable row's primary control is the row itself (click to activate) with a sibling mark-as-read
 * affordance while unread; a payload-less row never pretends to navigate. */
export function NotificationRow(props: NotificationRowProps): ReactNode {
  const row = useMergedNotificationRow(props.feedId);
  // Hooks must remain unconditional while an exact-removal frame makes this row disappear between renders; the
  // empty-id fallback is what keeps the two origin-host subscriptions below callable for a vanished row.
  const originHostId = row?.originHostId ?? "";
  const originHost = useHostDirectoryEntry(originHostId);
  // This machine - not the ambient active host. Pack-store events are machine-local; comparing against active
  // would mis-caption when the user has a remote host selected.
  const localHost = useReactiveLocalHostEntry();
  const runnerHost = useRunnerHostOrNull();
  const shouldReduceMotion = useReducedMotion() === true;
  // Subscribed, not read at render time: `originRefusal` is ready-session- aware, and a readiness flip changes
  // no value this row otherwise subscribes to.
  const originHasReadySession = useRemoteSessionPollReadiness(originHostId);
  if (row === null) return null;

  const packPresentation = resolvePackRowPresentation({
    attribution: row.providerPackAttribution,
    hasLocalHost: runnerHost?.hasLocalHost ?? false,
    localHostId: localHost?.hostId ?? null,
    body: row.body,
    hasPayload: row.payload !== null,
  });
  const isRead = row.readAt !== null;
  const originUnavailability = originRefusal({
    row,
    originEntry: originHost,
    hasReadySession: originHasReadySession,
  });
  const originUnavailable = originUnavailability !== null;
  const glyph = notificationRowGlyph(row);
  const Icon = glyph.icon;

  const motionProps = rowMotionProps({
    feedId: row.feedId,
    shouldReduceMotion,
  });

  // Same condition the navigable body button renders under, so keyboard
  // activation of a focused row and a click on that button are the same act.
  const canActivate =
    packPresentation.isNavigable && originUnavailability === null;
  // Only the row's own key events - a keydown bubbling up from one of its controls has already been handled by
  // that control (Enter on the trailing tick acknowledges; it must not also activate the row).
  const onRowKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!canActivate) return;
    event.preventDefault();
    props.onActivate(row);
  };

  return (
    <m.li
      layout={motionProps.layout}
      layoutId={motionProps.layoutId}
      exit={motionProps.exit}
      transition={{
        layout: { duration: 0.24, ease: "easeOut" },
        opacity: { duration: 0.12, ease: "easeOut" },
      }}
      // hover:/has-[:focus-visible]: give the whole row a subtle tint whenever any of its interactive controls is
      // hovered or keyboard- focused, so the user can see what they're targeting.
      tabIndex={-1}
      onKeyDown={onRowKeyDown}
      className={cn(
        "relative flex items-start gap-2.5 border-b border-border/60 py-2.5 pr-4 pl-6 outline-none last:border-b-0 hover:bg-foreground/6 focus-visible:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset has-[:focus-visible]:bg-foreground/6 active:press-scrim pointer-coarse:touch-chrome",
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
        originUnavailability={originUnavailability}
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
          onAcknowledge={props.onAcknowledge}
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
  readonly originUnavailability: HostUnavailability | null;
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

  if (props.isNavigable && props.originUnavailability === null) {
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
      {props.originUnavailability === null ? null : (
        <span
          data-testid="notification-origin-unavailable"
          className="block text-ui-xs text-muted-foreground"
        >
          {props.originUnavailability === "plan-restricted"
            ? "The originating host is local only on your current plan."
            : "The originating host is unavailable."}
        </span>
      )}
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
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/** Acknowledging notification awareness never resolves the underlying chat workflow. */
function NotificationRowTrailingControl(
  props: NotificationRowTrailingControlProps,
): ReactNode {
  if (props.isRead) return null;
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

/** It is a sibling of the navigable body button, never nested inside it, so a click can't activate the row. */
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
        className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/8 hover:text-foreground active:press-scrim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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

// Isolated leaf so the shared 60s clock only re-renders this span - the surrounding row, glyph, and button
// subtree stay still between ticks (and, critically, never touch the frozen outer shell dimensions).
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

/** Severity/category glyph selection - color is the only severity signal (no background tint, no icon-tile),
 * matching the approved flat visual contract. */
function notificationRowGlyph(row: MergedNotificationRow): RowGlyph {
  if (row.globalEntry !== null) {
    return globalEventGlyph(row.globalEntry.event);
  }
  if (row.appLocalKind !== null) {
    const tone =
      row.appLocalKind === "terminal.closed" ||
      row.appLocalKind === "terminal.crashed"
        ? TERMINAL_FAILURE_TONE
        : FAILURE_TONE;
    return { icon: tone.Icon, colorClassName: tone.className };
  }
  const statusTone = notificationFeedTone(row);
  const semanticIcon = hostNotificationSemanticIcon(row);
  if (statusTone !== null) {
    return {
      icon: semanticIcon ?? statusTone.Icon,
      colorClassName: statusTone.className,
    };
  }
  if (semanticIcon !== null) {
    return { icon: semanticIcon, colorClassName: NEUTRAL_COLOR };
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
    // Only reachable for an `info` row: the severity branches above already claim every
    // `done`/`failure`/`needs_action` host-operation row.
    case "host.operation.finished":
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
    // Needs-action, but not an agent prompt: the shared tones return null for
    // this kind, so the subject glyph is the whole signal.
    case "browser.human.needed":
      return { icon: Globe, colorClassName: NEUTRAL_COLOR };
    case null:
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
  }
}

/** Host events whose subject is not an agent keep their subject-specific glyph while severity continues to own
 * color. */
function hostNotificationSemanticIcon(
  row: MergedNotificationRow,
): LucideIcon | null {
  if (row.hostKind === "workspace.operation.failed") return FolderX;
  if (
    row.hostKind === "host.operation.finished" &&
    row.payload?.kind === "hostSurface"
  ) {
    return Trash2;
  }
  return null;
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
      // Fall through to a safe neutral fallback rather than an exhaustive `never` assertion - a server-added event
      // kind must degrade, not crash the renderer on a client that hasn't upgraded yet.
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
  }
}
