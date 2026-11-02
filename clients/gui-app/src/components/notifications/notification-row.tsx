import type { KeyboardEvent, ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  Bell,
  Check,
  CheckCircle2,
  FolderX,
  KeyRound,
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
  NOTIFICATION_STATUS_TONES,
  notificationFeedTone,
  TERMINAL_FAILURE_TONE,
} from "@/components/notifications/notification-indicator-tones";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationRowBotAvatar } from "@/components/notifications/notification-bots";
import { useStandaloneBotName } from "@/hooks/bots/use-standalone-bot-name";
import { notificationRowBotId } from "@/lib/notifications/notification-row-bot-id";
import { SecretGrantRequestCard } from "@/components/notifications/secret-grant-request-card";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostUnavailability,
  isConfirmedTransportRefusal,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { notificationPayloadRequiresOriginHost } from "@/hooks/notifications/use-notification-activation";
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
  /** Briefly identifies a row that just moved from Attention into Recent. */
  readonly highlightRelocation: boolean;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/**
 * Whether an origin-host-bound row must stop offering its action.
 *
 * DERIVATION, not the coarse bit, and the difference is the whole point of this
 * function existing. It used to disable the row for anything the directory did
 * not call `available`, which folded a failed liveness read in with a host that
 * is genuinely gone: an approval prompt on a perfectly healthy machine went
 * grey and un-actionable because one Redis read on the cloud side came back
 * blind. `indeterminate` therefore does NOT disable — the activation path dials
 * and fails on its own evidence, which is recoverable, where a disabled row is
 * a dead end the user cannot argue with.
 *
 * A CONFIRMED refusal still disables, because for it the action really has
 * nowhere to go: `offline` (the host is detached).
 *
 * "Confirmed" is asked through `isConfirmedTransportRefusal` - the SAME
 * ready-session-aware gate the activation path itself dials through
 * (`ensureOriginHostSelected` -> `dialableHostEndpoint`) - not by re-reading
 * the raw verdict here. The two must agree, and a hand-rolled second gate is
 * how they stop agreeing: reading `hostUnavailability` directly greyed out a
 * cloud-`offline` origin this client held a READY live session to (firsthand
 * proof the route works, which every other gate lets outrank the registry),
 * and refused the fuse-window recovery dial the transport would have
 * attempted. `hostUnavailability` now supplies only the per-reason copy once
 * the refusal is confirmed.
 *
 * `hasReadySession` is the component's REACTIVE answer to
 * `hasReadyRemoteSession` (via `useRemoteSessionPollReadiness`), not read
 * here: the session cache is pull-only and a readiness flip changes neither
 * the notification row nor any directory value, so a direct read froze the
 * refusal at whatever the cache said when something else happened to
 * re-render the row - the same staleness the host picker's refusal predicate
 * had.
 */
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
  // A confirmed refusal is exactly `offline`.
  return hostUnavailability(input.originEntry);
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

/**
 * One flat, balanced two-line row - a small semantic glyph, title/meta
 * content, trailing relative time, and exactly one primary interactive
 * control. A navigable row's primary control is the row itself (click to
 * activate) with a sibling mark-as-read affordance while unread; a
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
  // row disappear between renders; the empty-id fallback is what keeps the
  // two origin-host subscriptions below callable for a vanished row.
  const originHostId = row?.originHostId ?? "";
  const originHost = useHostDirectoryEntry(originHostId);
  const shouldReduceMotion = useReducedMotion() === true;
  // Subscribed, not read at render time: `originRefusal` is ready-session-
  // aware, and a readiness flip changes no value this row otherwise
  // subscribes to. An empty id reads as "no ready session", the right answer
  // for a row with no origin host.
  const originHasReadySession = useRemoteSessionPollReadiness(originHostId);
  if (row === null) return null;

  const isNavigable = row.payload !== null;
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
  const canActivate = isNavigable && originUnavailability === null;
  // Only the row's OWN key events - a keydown bubbling up from one of its
  // controls has already been handled by that control (Enter on the trailing
  // tick acknowledges; it must not also activate the row).
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
      // hover:/has-[:focus-visible]: give the whole row a subtle tint
      // whenever any of its interactive controls is hovered or keyboard-
      // focused, so the user can see what they're targeting - distinct from
      // the unread rail, which is a persistent state marker, not a hover
      // affordance (no persistent row tint). The row is not a Button, so it
      // opts into the shared press scrim itself; `hover:` is media-gated to
      // hover-capable pointers, so without it a finger sees nothing at all for
      // the whole press.
      //
      // `tabIndex={-1}` makes the row itself the arrow-key landing spot
      // (see `notification-feed-keyboard-navigation.ts`) without adding a Tab
      // stop: Tab order still runs through the row's controls only.
      tabIndex={-1}
      onKeyDown={onRowKeyDown}
      className="relative flex items-start gap-2.5 border-b border-border/60 py-2.5 pr-4 pl-6 outline-none last:border-b-0 hover:bg-foreground/6 focus-visible:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset has-[:focus-visible]:bg-foreground/6 active:press-scrim pointer-coarse:touch-chrome"
      data-testid="notification-entry"
      data-notification-id={row.feedId}
      data-notification-read={isRead ? "true" : "false"}
      data-notification-severity={row.severity}
      data-notification-origin-state={
        originUnavailable ? "unavailable" : "available"
      }
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
        <NotificationRowBotAvatar
          payload={row.payload}
          fallback={<Icon className={cn("size-4", glyph.colorClassName)} />}
        />
      </span>
      <NotificationRowWithSecrets row={row}>
        <NotificationRowMain
          row={row}
          isRead={isRead}
          isNavigable={isNavigable}
          originUnavailability={originUnavailability}
          onActivate={props.onActivate}
        />
      </NotificationRowWithSecrets>
      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        <NotificationTimestamp createdAt={row.createdAt} />
        <NotificationRowTrailingControl
          row={row}
          isNavigable={isNavigable}
          isRead={isRead}
          onAcknowledge={props.onAcknowledge}
        />
      </div>
    </m.li>
  );
}

/**
 * A grant request's card sits UNDER the row's main area and never inside it,
 * because that area is one button when the row is navigable and the card's
 * controls are buttons of their own.
 *
 * Every other row gets its main area back untouched, with no wrapper.
 */
function NotificationRowWithSecrets(props: {
  readonly row: MergedNotificationRow;
  readonly children: ReactNode;
}): ReactNode {
  const secrets = props.row.secrets ?? null;
  if (secrets === null) return props.children;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      {props.children}
      <SecretGrantRequestCard
        detail={secrets}
        resolved={props.row.resolvedAt !== null}
      />
    </div>
  );
}

function NotificationRowMain(props: {
  readonly row: MergedNotificationRow;
  readonly isRead: boolean;
  readonly isNavigable: boolean;
  readonly originUnavailability: HostUnavailability | null;
  readonly onActivate: (row: MergedNotificationRow) => void;
}): ReactNode {
  const title = useStandaloneBotName(
    notificationRowBotId(props.row),
    props.row.title,
  );
  const body = (
    <NotificationRowBody
      title={title}
      body={props.row.body}
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

  return (
    <div className="min-w-0 flex-1">
      {body}
      {props.originUnavailability === null ? null : (
        <span
          data-testid="notification-origin-unavailable"
          className="block text-ui-xs text-muted-foreground"
        >
          The originating host is unavailable.
        </span>
      )}
    </div>
  );
}

interface NotificationRowTrailingControlProps {
  readonly row: MergedNotificationRow;
  readonly isNavigable: boolean;
  readonly isRead: boolean;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
}

/** The sibling trailing control acknowledges every unread row, including
 * questions and permission requests. Acknowledging notification awareness
 * never resolves the underlying chat workflow. */
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

/** The shared right-edge tick button. Mark-as-read and acknowledge use the
 * same affordance visually. It is a sibling of the
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
  return hostKindGlyph(row.hostKind);
}

const NEUTRAL_BELL: RowGlyph = { icon: Bell, colorClassName: NEUTRAL_COLOR };
const FAILED_CHAT: RowGlyph = {
  icon: MessageSquareX,
  colorClassName: FAILURE_COLOR,
};
const SECRET_GLYPH: RowGlyph = {
  icon: KeyRound,
  colorClassName: NEUTRAL_COLOR,
};

/**
 * The fallback glyph of every host kind. A record, so a new kind cannot
 * compile without one.
 */
const HOST_KIND_GLYPHS: Record<
  NonNullable<MergedNotificationRow["hostKind"]>,
  RowGlyph
> = {
  "agent.stopped": NEUTRAL_BELL,
  "agent.stalled": FAILED_CHAT,
  "approval.requested": NEUTRAL_BELL,
  "interview.requested": NEUTRAL_BELL,
  "workspace.operation.failed": FAILED_CHAT,
  // Only reachable for an `info` row: the severity branches above already
  // claim every `done`/`failure`/`needs_action` host-operation row, and the
  // kind itself says nothing about how the operation ended.
  "host.operation.finished": NEUTRAL_BELL,
  // Retain the browser glyph for resolved/informational browser rows too.
  "browser.human.needed": {
    icon: NOTIFICATION_STATUS_TONES.browser.Icon,
    colorClassName: NOTIFICATION_STATUS_TONES.browser.className,
  },
  // A secret is the subject of this row, whatever the request's state.
  "secret.grant.requested": SECRET_GLYPH,
  // The reader's own role is the subject, so the row carries the same shield as
  // the task-sharing role change it mirrors.
  "team.role.changed": { icon: Shield, colorClassName: INVITE_COLOR },
  // Never rendered: the merged rows drop the kind.
  "secret.export.minted": NEUTRAL_BELL,
  "secret.rotated": NEUTRAL_BELL,
  "secret.removed": NEUTRAL_BELL,
  "sandbox.notice": NEUTRAL_BELL,
  "notification.hooks.removed": NEUTRAL_BELL,
  "team.member.removed": NEUTRAL_BELL,
  "team.member.joined": NEUTRAL_BELL,
  "team.policy.unapplied": NEUTRAL_BELL,
  "team.policy.authority_expired": NEUTRAL_BELL,
  "team.installing_admin.gone": NEUTRAL_BELL,
  "team.plan.unlinked": NEUTRAL_BELL,
  "team.pods.full": NEUTRAL_BELL,
  "team.host.returned": NEUTRAL_BELL,
  "environment.move.stalled": NEUTRAL_BELL,
  "environment.apply.failed": NEUTRAL_BELL,
};

/** The glyph a host row falls back to once severity and subject have both
 * declined to pick one. */
function hostKindGlyph(hostKind: MergedNotificationRow["hostKind"]): RowGlyph {
  if (hostKind === null) return NEUTRAL_BELL;
  return HOST_KIND_GLYPHS[hostKind];
}

/**
 * A failed workspace operation keeps its folder glyph while severity
 * continues to own color. Without this layer, the shared failure tone turns
 * it into a chat bubble before the host-kind fallback can run.
 */
function hostNotificationSemanticIcon(
  row: MergedNotificationRow,
): LucideIcon | null {
  if (row.hostKind === "workspace.operation.failed") return FolderX;
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
      // Fall through to a safe neutral fallback rather than an exhaustive
      // `never` assertion - a server-added event kind must degrade, not
      // crash the renderer on a client that hasn't upgraded yet.
      return { icon: Bell, colorClassName: NEUTRAL_COLOR };
  }
}
