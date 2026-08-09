import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { BellOff, CheckCheck, Settings, Trash2 } from "lucide-react";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationFilterMenu } from "@/components/notifications/notification-filter-menu";
import { NotificationRow } from "@/components/notifications/notification-row";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useNotificationCenterArrivals } from "@/hooks/notifications/use-notification-center-arrivals";
import { useNotificationCenterScrollAnchor } from "@/hooks/notifications/use-notification-center-scroll-anchor";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import {
  useNotificationFeedMode,
  type NotificationFeedMode,
} from "@/lib/notifications/notification-feed-mode";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import {
  ALL_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import { cn } from "@/lib/utils";
import {
  temporalGroupForTimestamp,
  type NotificationTemporalGroup,
} from "@/lib/notifications/notification-temporal-group";
import { useSampledNow } from "@/lib/relative-time";
import {
  type MergedNotificationRow,
  useAttentionNotificationIds,
  useMergedNotificationOccurrenceEntries,
  useMergedNotificationRow,
  useMergedNotificationUnreadCount,
  useMergedNotificationsActions,
  useNotificationCenterHostState,
  useRecentNotificationIds,
} from "@/stores/notifications/merged-notifications";
import {
  type CloudNotificationsConnectionState,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

interface NotificationsPopoverProps {
  readonly onNavigate: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly shellRef: RefObject<HTMLDivElement | null>;
  readonly shellStyle: CSSProperties;
  /** Forwarded verbatim to `NotificationFilterMenu`'s `onOpenChange` - see
   * that prop's doc for why the ancestor Popover's outside-dismissal guard
   * needs it. */
  readonly onFilterMenuOpenChange: (open: boolean) => void;
}

interface NotificationFeedStatusPresentation {
  readonly title: string;
  readonly detail: string;
  readonly isPending: boolean;
}

const TEMPORAL_GROUP_LABEL: Readonly<
  Record<NotificationTemporalGroup, string>
> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

// A cursor with more attention rows to load must keep the section (and its
// Load-more control) visible even once every currently loaded row has left
// Attention - otherwise the continuation is unreachable until reopen.
function isAttentionSectionVisible(input: {
  readonly loadedAttentionCount: number;
  readonly canLoadMoreAttention: boolean;
}): boolean {
  return input.loadedAttentionCount > 0 || input.canLoadMoreAttention;
}

// The "Mark all read" double-tick now also dismisses loaded Attention rows, so
// it stays actionable whenever there is EITHER unread activity to mark read OR a
// loaded HOST Attention row to dismiss - a needs_action row read via navigation
// is no longer unread but is still dismissable, so `unreadCount` alone would
// wrongly disable it.
//
// Retained HOST Attention rows only count while an active host exists: a real
// disconnect keeps the rendered rows but makes their mark-read/resolve
// mutations unbound, so counting them then would re-enable the control into a
// pair of failing RPCs. Unread global/app-local rows stay locally actionable
// regardless and flow through `unreadCount` (which itself drops the host
// contribution to 0 once the summary is unknown).
function isMarkAllReadDisabled(input: {
  readonly unreadCount: number;
  readonly loadedHostAttentionCount: number;
  readonly hasActiveHost: boolean;
  readonly cloudConnectionState: CloudNotificationsConnectionState | null;
}): boolean {
  if (input.cloudConnectionState !== null) {
    return (
      input.unreadCount === 0 || input.cloudConnectionState !== "connected"
    );
  }
  const actionableHostAttention = input.hasActiveHost
    ? input.loadedHostAttentionCount
    : 0;
  return input.unreadCount === 0 && actionableHostAttention === 0;
}

/** Local-fallback header subtitle text. A partial host state is either
 * transient (still
 * connecting - the exact wording carries no permanence claim) or confirmed
 * permanent for this session (the stream's mirror-compat check has already
 * resolved `host.notifications.feed.subscribe` as `"unsupported"` on an old
 * host) - only the confirmed case gets version-specific wording. */
function localNotificationsSubtitle(input: {
  readonly isPartial: boolean;
  readonly hostLabel: string | null;
  readonly notificationsSupport: StreamMethodSupport | null;
}): string {
  if (!input.isPartial) {
    return `Task activity from ${input.hostLabel ?? "this device"}`;
  }
  if (input.notificationsSupport === "unsupported") {
    return "Task activity isn't available on this host version";
  }
  return "Task activity is unavailable right now";
}

function notificationsSubtitle(
  feedMode: NotificationFeedMode,
  input: Parameters<typeof localNotificationsSubtitle>[0],
): string | null {
  return feedMode === "local" ? localNotificationsSubtitle(input) : null;
}

/**
 * Notification center surface content: header (title, optional local-host
 * subtitle, Filter, Mark all read, overflow Settings), a single scrolling
 * feed body (Needs attention, then Recent activity with temporal
 * separators), and a fixed "Load older activity" footer. Outer sizing is
 * entirely owned by the caller (`NotificationsBell`) via `shellRef`/
 * `shellStyle` - this component never touches its own outer dimensions, so
 * none of its content transitions can violate the frozen open-session rect.
 */
export function NotificationsPopover(
  props: NotificationsPopoverProps,
): ReactNode {
  const {
    onNavigate,
    headingRef,
    shellRef,
    shellStyle,
    onFilterMenuOpenChange,
  } = props;
  const attentionIds = useAttentionNotificationIds();
  const recentIds = useRecentNotificationIds();
  const unreadCount = useMergedNotificationUnreadCount();
  const actions = useMergedNotificationsActions();
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const hostState = useNotificationCenterHostState();
  const feedMode = useNotificationFeedMode();
  const cloudConnectionState = useCloudNotificationsStore(
    (state) => state.connectionState,
  );
  const cloudHasSnapshot = useCloudNotificationsStore(
    (state) => state.hasSnapshot,
  );
  const cloudPresentationState = cloudStateForFeedMode(
    feedMode,
    cloudConnectionState,
  );
  const feedStatus = notificationFeedStatus({
    feedMode,
    connectionState: cloudConnectionState,
    hasSnapshot: cloudHasSnapshot,
  });
  // Distinguishes a permanent condition (this host's stream mirror-compat
  // check has already confirmed it will never support the notifications
  // feed) from a merely transient one (still connecting) - both leave
  // `hostState.isPartial` true, but only the confirmed case should be worded
  // as permanent in the local fallback subtitle below.
  const notificationsSupport = useStreamMethodSupport(
    "host.notifications.feed.subscribe",
  );
  // Authoritative active-host signal for the "Mark all read" enablement gate -
  // `null` during a disconnect even though the runtime binding is retained.
  const activeHostId = useReactiveActiveHostId();
  // Loaded HOST Attention rows (feed ids are `host:<id>`); app-local/global
  // attention is locally actionable and already reflected in `unreadCount`.
  const loadedHostAttentionCount = attentionIds.filter((feedId) =>
    feedId.startsWith("host:"),
  ).length;
  const { activate } = useNotificationActivation();
  const { openSettings } = useSystemTabModalActions();
  const unreadOnly = useNotificationsPopoverStore((state) => state.unreadOnly);
  const categories = useNotificationsPopoverStore((state) => state.categories);
  const setUnreadOnly = useNotificationsPopoverStore(
    (state) => state.setUnreadOnly,
  );
  const toggleCategory = useNotificationsPopoverStore(
    (state) => state.toggleCategory,
  );
  const resetFilters = useNotificationsPopoverStore(
    (state) => state.resetFilters,
  );
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const handleFilterPointerDownOutside = useCallback(
    (point: { readonly clientX: number; readonly clientY: number }) => {
      const shell = shellRef.current;
      if (shell === null) return;
      const rect = shell.getBoundingClientRect();
      const isInsideShell =
        point.clientX >= rect.left &&
        point.clientX <= rect.right &&
        point.clientY >= rect.top &&
        point.clientY <= rect.bottom;
      if (!isInsideShell) {
        setOpen(false);
      }
    },
    [setOpen, shellRef],
  );

  // Combined render order (Attention section, then Recent) - must match DOM
  // order exactly, since scroll anchoring measures rows by this sequence.
  const orderedFeedIds = useMemo(
    () => [...attentionIds, ...recentIds],
    [attentionIds, recentIds],
  );
  const {
    scrollRef: feedScrollRef,
    isAtTop,
    scrollToTop,
  } = useNotificationCenterScrollAnchor({ orderedFeedIds });

  // Full, unfiltered occurrence order is the identity source for live-arrival
  // detection, so a Recent filter can never blind the arrival set to a row it
  // currently hides (see "N-new" in the technical plan).
  const fullOccurrenceOrder = useMergedNotificationOccurrenceEntries();
  const occurrenceKeyByFeedId = useMemo(
    () =>
      new Map(
        fullOccurrenceOrder.map((entry) => [entry.feedId, entry.occurrenceKey]),
      ),
    [fullOccurrenceOrder],
  );
  const visibleOccurrenceKeys = useMemo(
    () =>
      orderedFeedIds
        .map((feedId) => occurrenceKeyByFeedId.get(feedId))
        .filter((key): key is string => key !== undefined),
    [orderedFeedIds, occurrenceKeyByFeedId],
  );
  const { newCount: newArrivalCount, reveal: revealArrivals } =
    useNotificationCenterArrivals({
      isAtTop,
      fullOrder: fullOccurrenceOrder,
      visibleOccurrenceKeys,
    });
  const revealNewArrivals = useCallback(() => {
    Analytics.getInstance().track(AnalyticsEvent.NotificationNewRevealed, {
      count_bucket: analyticsCountBucket(newArrivalCount),
    });
    scrollToTop();
    revealArrivals();
  }, [scrollToTop, revealArrivals, newArrivalCount]);

  const handleActivate = useCallback(
    (row: MergedNotificationRow) => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: Date.now(),
        feedId: row.feedId,
        originHostId: row.originHostId,
        // Fires synchronously right after routing, so the center closes on
        // dispatch (`onSuccess: onNavigate`). The origin-host guard inside
        // the hook can still settle this as `"failure"` (no toast, nothing
        // actually failed) - in that case the center stays open and the row
        // stays unread, same as before.
        onResult: activationResultHandler({
          row,
          feedId: row.feedId,
          surface: "center",
          markAsRead: actions.markAsRead,
          onSuccess: onNavigate,
        }),
      });
    },
    [actions, activate, onNavigate],
  );

  const handleAcknowledge = useCallback(
    (row: MergedNotificationRow) => {
      if (row.payload === null) {
        // Payload-less rows have no preflight and no sibling action: the
        // acknowledge click IS the activation.
        Analytics.getInstance().track(
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: row.category,
            section: classifyNotificationLifecycle(row).section,
            surface: "center",
            outcome: "success",
          },
        );
      }
      Analytics.getInstance().track(AnalyticsEvent.NotificationMarkedRead, {
        category: row.category,
        acknowledgment_source: "explicit_action",
      });
      actions.markAsRead(row);
    },
    [actions],
  );

  const handleResolve = useCallback(
    (row: MergedNotificationRow) => {
      // Dismiss stamps `resolvedAt` (and marks read), so it registers as an
      // explicit acknowledgment for the same metric the mark-read control
      // reports - it just also clears the row from the blocking tier.
      Analytics.getInstance().track(AnalyticsEvent.NotificationMarkedRead, {
        category: row.category,
        acknowledgment_source: "explicit_action",
      });
      actions.resolve(row);
    },
    [actions],
  );

  const handleMarkAllRead = useCallback(() => {
    Analytics.getInstance().track(AnalyticsEvent.NotificationsMarkedAllRead, {
      affected_count_bucket: hostState.isPartial
        ? "unknown"
        : analyticsCountBucket(unreadCount),
    });
    actions.markAllAsRead();
  }, [actions, hostState.isPartial, unreadCount]);

  const handleClearAll = useCallback(() => {
    setClearAllConfirmOpen(true);
  }, []);

  const handleConfirmClearAll = useCallback(() => {
    actions.clearAll();
    setClearAllConfirmOpen(false);
  }, [actions]);

  const handleUnreadOnlyChange = useCallback(
    (next: boolean) => {
      Analytics.getInstance().track(AnalyticsEvent.NotificationFilterChanged, {
        filter: "unread_only",
        enabled: next,
      });
      setUnreadOnly(next);
    },
    [setUnreadOnly],
  );

  const handleToggleCategory = useCallback(
    (category: NotificationCategory) => {
      Analytics.getInstance().track(AnalyticsEvent.NotificationFilterChanged, {
        filter: category,
        enabled: !categories.has(category),
      });
      toggleCategory(category);
    },
    [categories, toggleCategory],
  );

  const handleOpenSettings = useCallback(() => {
    onNavigate();
    openSettings({ section: "notifications", resetToGeneral: false });
  }, [onNavigate, openSettings]);

  const isFiltered =
    unreadOnly || categories.size < ALL_NOTIFICATION_CATEGORIES.size;
  const isEmpty = fullOccurrenceOrder.length === 0;
  const isRecentFilteredEmpty =
    !isEmpty && recentIds.length === 0 && isFiltered;

  const canLoadOlder =
    feedMode === "local" &&
    (unreadOnly ? actions.canLoadMoreUnreadRecent : actions.canLoadMoreHost);
  const isLoadingOlder = unreadOnly
    ? actions.isLoadingMoreUnreadRecent
    : actions.isLoadingMoreHost;
  const loadOlder = unreadOnly
    ? actions.loadMoreUnreadRecent
    : actions.loadMoreHost;
  const loadOlderError = unreadOnly
    ? actions.hasUnreadRecentLoadError
    : actions.hasHostLoadError;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={shellRef}
        style={shellStyle}
        className="flex w-[min(90vw,34rem)] min-w-0 flex-col gap-0 overflow-hidden"
        data-testid="notifications-popover"
      >
        <NotificationsPopoverHeader
          headingRef={headingRef}
          unreadOnly={unreadOnly}
          categories={categories}
          onUnreadOnlyChange={handleUnreadOnlyChange}
          onToggleCategory={handleToggleCategory}
          onFilterMenuOpenChange={onFilterMenuOpenChange}
          onFilterPointerDownOutside={handleFilterPointerDownOutside}
          onMarkAllRead={handleMarkAllRead}
          isMarkAllReadDisabled={isMarkAllReadDisabled({
            unreadCount,
            loadedHostAttentionCount,
            hasActiveHost: activeHostId !== null,
            cloudConnectionState: cloudPresentationState,
          })}
          showClearAll={feedMode === "cloud"}
          isClearAllDisabled={
            !cloudHasSnapshot ||
            cloudConnectionState !== "connected" ||
            fullOccurrenceOrder.length === 0
          }
          onClearAll={handleClearAll}
          onOpenSettings={handleOpenSettings}
          subtitle={notificationsSubtitle(feedMode, {
            isPartial: hostState.isPartial,
            hostLabel: hostState.hostLabel,
            notificationsSupport,
          })}
        />

        <OriginUnavailableBanner />
        <NotificationFeedStatusBanner
          isEmpty={isEmpty}
          presentation={feedStatus}
        />

        <div
          ref={feedScrollRef}
          className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
          data-testid="notifications-feed-scrollport"
        >
          {newArrivalCount > 0 && (
            <button
              type="button"
              onClick={revealNewArrivals}
              data-testid="notifications-new-arrivals"
              className="sticky top-2 z-30 mx-auto mb-1 block w-max rounded-full border border-border bg-popover px-2.5 py-1 text-ui-xs font-medium text-foreground shadow-sm"
            >
              {newArrivalCount} new notification
              {newArrivalCount === 1 ? "" : "s"}
            </button>
          )}
          <NotificationsFeedContent isEmpty={isEmpty} presentation={feedStatus}>
            <>
              {isAttentionSectionVisible({
                loadedAttentionCount: attentionIds.length,
                canLoadMoreAttention: actions.canLoadMoreAttention,
              }) ? (
                <section className="px-4 pt-3">
                  <SectionLabel>Needs attention</SectionLabel>
                  {/* -mx-4 breaks the row list out of the section's inset so
                  each row's bottom divider reaches the popover's true edges;
                  rows restore the same visual inset as their own content
                  padding (see notification-row.tsx). */}
                  <ul className="-mx-4 flex flex-col">
                    {attentionIds.map((id) => (
                      <NotificationRow
                        key={id}
                        feedId={id}
                        onActivate={handleActivate}
                        onAcknowledge={handleAcknowledge}
                        onResolve={handleResolve}
                      />
                    ))}
                  </ul>
                  {actions.canLoadMoreAttention ? (
                    <LoadMoreButton
                      label="Load more attention"
                      isLoading={actions.isLoadingMoreAttention}
                      hasError={actions.hasAttentionLoadError}
                      onClick={() => actions.loadMoreAttention()}
                      testId="notifications-load-more-attention"
                    />
                  ) : null}
                </section>
              ) : null}

              <section className="px-4 pt-3 pb-2">
                <SectionLabel>Recent activity</SectionLabel>
                <RecentSectionBody
                  recentIds={recentIds}
                  isFilteredEmpty={isRecentFilteredEmpty}
                  onActivate={handleActivate}
                  onAcknowledge={handleAcknowledge}
                  onResolve={handleResolve}
                  onResetFilters={resetFilters}
                />
              </section>
            </>
          </NotificationsFeedContent>
        </div>

        {canLoadOlder ? (
          <footer className="shrink-0 border-t border-border/60 p-2">
            <LoadMoreButton
              label="Load older activity"
              isLoading={isLoadingOlder}
              hasError={loadOlderError}
              onClick={() => loadOlder()}
              testId="notifications-load-older"
            />
          </footer>
        ) : null}
      </div>
      <ConfirmDestructiveDialog
        open={clearAllConfirmOpen}
        onOpenChange={setClearAllConfirmOpen}
        title="Clear all cloud notifications?"
        description="This permanently clears every notification currently visible in your cloud feed across your devices."
        cascadeSummary={null}
        actionLabel="Clear all"
        isPending={false}
        onConfirm={handleConfirmClearAll}
      />
    </TooltipProvider>
  );
}

interface NotificationsPopoverHeaderProps {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly unreadOnly: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
  readonly onUnreadOnlyChange: (next: boolean) => void;
  readonly onToggleCategory: (category: NotificationCategory) => void;
  readonly onFilterMenuOpenChange: (open: boolean) => void;
  readonly onFilterPointerDownOutside: (point: {
    readonly clientX: number;
    readonly clientY: number;
  }) => void;
  readonly onMarkAllRead: () => void;
  readonly isMarkAllReadDisabled: boolean;
  readonly showClearAll: boolean;
  readonly isClearAllDisabled: boolean;
  readonly onClearAll: () => void;
  readonly onOpenSettings: () => void;
  readonly subtitle: string | null;
}

function NotificationsPopoverHeader({
  headingRef,
  unreadOnly,
  categories,
  onUnreadOnlyChange,
  onToggleCategory,
  onFilterMenuOpenChange,
  onFilterPointerDownOutside,
  onMarkAllRead,
  isMarkAllReadDisabled,
  showClearAll,
  isClearAllDisabled,
  onClearAll,
  onOpenSettings,
  subtitle,
}: NotificationsPopoverHeaderProps): ReactNode {
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border/60 bg-popover px-4 pt-3 pb-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-ui-sm font-semibold outline-none"
        >
          Notifications
        </h2>
        <div className="flex shrink-0 items-center gap-0.5">
          <NotificationFilterMenu
            unreadOnly={unreadOnly}
            categories={categories}
            onUnreadOnlyChange={onUnreadOnlyChange}
            onToggleCategory={onToggleCategory}
            onOpenChange={onFilterMenuOpenChange}
            onPointerDownOutside={onFilterPointerDownOutside}
          />
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
              onClick={onMarkAllRead}
              disabled={isMarkAllReadDisabled}
              data-testid="notifications-mark-all-read"
              aria-label="Mark all notifications as read"
              className="text-muted-foreground hover:text-foreground"
            >
              <CheckCheck className="size-3.5" aria-hidden />
            </Button>
          </TooltipWrapper>
          {showClearAll ? (
            <TooltipWrapper
              label="Clear cloud notifications"
              side="bottom"
              sideOffset={6}
              align="end"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onClearAll}
                disabled={isClearAllDisabled}
                data-testid="notifications-clear-all"
                aria-label="Clear cloud notifications"
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </TooltipWrapper>
          ) : null}
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
              onClick={onOpenSettings}
              data-testid="notifications-open-settings"
              aria-label="Notification settings"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="size-3.5" aria-hidden />
            </Button>
          </TooltipWrapper>
        </div>
      </div>
      {subtitle === null ? null : (
        <p
          data-testid="notifications-subtitle"
          className="truncate text-ui-xs text-muted-foreground"
        >
          {subtitle}
        </p>
      )}
    </header>
  );
}

function cloudStateForFeedMode(
  feedMode: "local" | "cloud" | "upgrade-required",
  connectionState: CloudNotificationsConnectionState,
): CloudNotificationsConnectionState | null {
  if (feedMode === "upgrade-required") return "unavailable";
  return feedMode === "cloud" ? connectionState : null;
}

function notificationFeedStatus(input: {
  readonly feedMode: NotificationFeedMode;
  readonly connectionState: CloudNotificationsConnectionState;
  readonly hasSnapshot: boolean;
}): NotificationFeedStatusPresentation | null {
  if (input.feedMode === "local") return null;
  if (input.feedMode === "upgrade-required") {
    return {
      title: "Notifications unavailable",
      detail: "Update Traycer to reconnect to your notification feed.",
      isPending: false,
    };
  }
  if (input.connectionState === "connected" && input.hasSnapshot) return null;
  if (!input.hasSnapshot && input.connectionState === "connecting") {
    return {
      title: "Loading notifications",
      detail: "Fetching your notification history.",
      isPending: true,
    };
  }
  if (input.hasSnapshot && input.connectionState !== "unavailable") {
    return {
      title: "Reconnecting to notifications",
      detail: "Refreshing your notification history.",
      isPending: true,
    };
  }
  return {
    title: "Notifications unavailable",
    detail: "We’ll keep trying to reconnect.",
    isPending: false,
  };
}

function NotificationFeedStatus(props: {
  readonly presentation: NotificationFeedStatusPresentation;
  readonly compact: boolean;
}): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        props.compact
          ? "flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2 text-muted-foreground"
          : "flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground",
      )}
      data-testid="notifications-feed-status"
    >
      {props.presentation.isPending ? (
        <AgentSpinningDots
          className="text-muted-foreground/60"
          testId="notifications-feed-status-spinner"
          variant={undefined}
        />
      ) : (
        <BellOff
          className={cn(
            props.compact
              ? "size-3.5 shrink-0 text-muted-foreground/60"
              : "size-8 text-muted-foreground/45",
          )}
          aria-hidden
        />
      )}
      <div className={cn(props.compact ? "min-w-0" : "space-y-1")}>
        <p
          className={cn(
            props.compact
              ? "text-ui-xs text-muted-foreground"
              : "text-ui-sm text-muted-foreground/60",
          )}
        >
          {props.presentation.title}
        </p>
        {props.compact ? null : (
          <p className="text-ui-xs text-muted-foreground/50">
            {props.presentation.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function NotificationFeedStatusBanner(props: {
  readonly isEmpty: boolean;
  readonly presentation: NotificationFeedStatusPresentation | null;
}): ReactNode {
  if (props.isEmpty || props.presentation === null) return null;
  return <NotificationFeedStatus presentation={props.presentation} compact />;
}

function NotificationsFeedContent(props: {
  readonly isEmpty: boolean;
  readonly presentation: NotificationFeedStatusPresentation | null;
  readonly children: ReactNode;
}): ReactNode {
  if (!props.isEmpty) return props.children;
  if (props.presentation !== null) {
    return (
      <NotificationFeedStatus
        presentation={props.presentation}
        compact={false}
      />
    );
  }
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground"
      data-testid="notifications-empty"
    >
      <BellOff className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/60">
          You&apos;re all caught up
        </p>
        <p className="text-ui-xs text-muted-foreground/50">
          New notifications will appear here.
        </p>
      </div>
    </div>
  );
}

/** One-open-cycle banner for a native click whose captured origin host no
 * longer matches the active host (see `notifications-popover-store.ts`).
 * Self-selects from the store so the parent doesn't carry this branch. */
function OriginUnavailableBanner(): ReactNode {
  const originUnavailable = useNotificationsPopoverStore(
    (state) => state.originUnavailable,
  );
  const hostLabel = useNotificationsPopoverStore(
    (state) => state.originUnavailableHostLabel,
  );
  if (!originUnavailable) return null;
  return (
    <p
      data-testid="notifications-origin-unavailable"
      className="shrink-0 border-b border-border/60 bg-muted/40 px-4 py-2 text-ui-xs text-muted-foreground"
    >
      This notification is from {hostLabel ?? "another device"}, which
      isn&apos;t the active device right now.
    </p>
  );
}

interface RecentSectionBodyProps {
  readonly recentIds: ReadonlyArray<string>;
  readonly isFilteredEmpty: boolean;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
  readonly onResolve: (row: MergedNotificationRow) => void;
  readonly onResetFilters: () => void;
}

function RecentSectionBody(props: RecentSectionBodyProps): ReactNode {
  if (props.recentIds.length > 0) {
    return (
      <RecentRowList
        ids={props.recentIds}
        onActivate={props.onActivate}
        onAcknowledge={props.onAcknowledge}
        onResolve={props.onResolve}
      />
    );
  }
  if (props.isFilteredEmpty) {
    return <FilteredEmptyState onReset={props.onResetFilters} />;
  }
  return (
    <p
      data-testid="notifications-recent-empty"
      className="py-4 text-center text-ui-xs text-muted-foreground"
    >
      Nothing here yet.
    </p>
  );
}

interface RecentRowListProps {
  readonly ids: ReadonlyArray<string>;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
  readonly onResolve: (row: MergedNotificationRow) => void;
}

/** Inserts a temporal separator whenever the calendar-day group changes
 * along the already-chronological Recent projection. `-mx-4` breaks the row
 * list out of the section's inset so each row's bottom divider reaches the
 * popover's true edges - rows restore the same visual inset via their own
 * content padding (see notification-row.tsx). */
function RecentRowList(props: RecentRowListProps): ReactNode {
  const now = useSampledNow();
  return (
    <ul className="-mx-4 flex flex-col">
      {props.ids.map((id, index) => (
        <RecentRow
          key={id}
          feedId={id}
          previousFeedId={index === 0 ? null : props.ids[index - 1]}
          now={now}
          onActivate={props.onActivate}
          onAcknowledge={props.onAcknowledge}
          onResolve={props.onResolve}
        />
      ))}
    </ul>
  );
}

interface RecentRowProps {
  readonly feedId: string;
  readonly previousFeedId: string | null;
  readonly now: number;
  readonly onActivate: (row: MergedNotificationRow) => void;
  readonly onAcknowledge: (row: MergedNotificationRow) => void;
  readonly onResolve: (row: MergedNotificationRow) => void;
}

function RecentRow(props: RecentRowProps): ReactNode {
  const row = useMergedNotificationRow(props.feedId);
  const previousRow = useMergedNotificationRow(props.previousFeedId ?? "");
  if (row === null) return null;
  const group = temporalGroupForTimestamp(row.createdAt, props.now);
  const previousGroup =
    previousRow !== null
      ? temporalGroupForTimestamp(previousRow.createdAt, props.now)
      : null;
  return (
    <>
      {group !== previousGroup && (
        <li
          data-testid="notification-temporal-separator"
          className="sticky top-5 z-10 bg-popover px-4 py-1 text-micro text-muted-foreground/60 first:mt-0"
        >
          {TEMPORAL_GROUP_LABEL[group]}
        </li>
      )}
      <NotificationRow
        feedId={props.feedId}
        onActivate={props.onActivate}
        onAcknowledge={props.onAcknowledge}
        onResolve={props.onResolve}
      />
    </>
  );
}

function SectionLabel(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-1 bg-popover px-4 py-1 text-overline font-semibold uppercase tracking-wide text-muted-foreground">
      {props.children}
    </div>
  );
}

interface LoadMoreButtonProps {
  readonly label: string;
  readonly isLoading: boolean;
  readonly hasError: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}

/** Recoverable inline error/retry state occupies the same footprint as the
 * normal control - it never collapses the shell, and retrying just
 * re-invokes the same load action against the still-current cursor. */
function LoadMoreButton(props: LoadMoreButtonProps): ReactNode {
  if (props.hasError) {
    return (
      <div
        data-testid={`${props.testId}-error`}
        className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-ui-xs text-destructive"
      >
        <span>Couldn&apos;t load more.</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onClick}
          data-testid={`${props.testId}-retry`}
          className="h-auto px-2 py-0.5 text-ui-xs text-destructive hover:text-destructive"
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={props.onClick}
      disabled={props.isLoading}
      data-testid={props.testId}
      className="mt-1 w-full gap-1.5 text-ui-xs text-muted-foreground"
    >
      {props.label}
      {props.isLoading ? (
        <AgentSpinningDots
          className="text-current"
          testId={`${props.testId}-spinner`}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}

function FilteredEmptyState(props: {
  readonly onReset: () => void;
}): ReactNode {
  return (
    <div
      className="flex flex-col items-center gap-2 py-6 text-center"
      data-testid="notifications-filter-empty"
    >
      <p className="text-ui-xs text-muted-foreground">
        No activity matches this filter.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={props.onReset}
        data-testid="notifications-filter-reset"
        className="text-ui-xs"
      >
        Reset filters
      </Button>
    </div>
  );
}
