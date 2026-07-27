import {
  useCallback,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { BellOff, CheckCheck, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationFilterMenu } from "@/components/notifications/notification-filter-menu";
import { NotificationRow } from "@/components/notifications/notification-row";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useNotificationCenterArrivals } from "@/hooks/notifications/use-notification-center-arrivals";
import { useNotificationCenterScrollAnchor } from "@/hooks/notifications/use-notification-center-scroll-anchor";
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

/**
 * Notification center surface content: header (title, active-device/partial
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
  const hostState = useNotificationCenterHostState();
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
      actions.markAsRead(row.feedId);
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

  const canLoadOlder = unreadOnly
    ? actions.canLoadMoreUnreadRecent
    : actions.canLoadMoreHost;
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
                onUnreadOnlyChange={handleUnreadOnlyChange}
                onToggleCategory={handleToggleCategory}
                onOpenChange={onFilterMenuOpenChange}
                onPointerDownOutside={handleFilterPointerDownOutside}
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
                  onClick={handleMarkAllRead}
                  disabled={unreadCount === 0}
                  data-testid="notifications-mark-all-read"
                  aria-label="Mark all notifications as read"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <CheckCheck className="size-3.5" aria-hidden />
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
                  aria-label="Notification settings"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Settings className="size-3.5" aria-hidden />
                </Button>
              </TooltipWrapper>
            </div>
          </div>
          <p
            data-testid="notifications-subtitle"
            className="truncate text-ui-xs text-muted-foreground"
          >
            {hostState.isPartial
              ? "Task activity is unavailable right now"
              : `Task activity from ${hostState.hostLabel ?? "this device"}`}
          </p>
        </header>

        <OriginUnavailableBanner />

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
              className="sticky top-2 z-10 mx-auto mb-1 block w-max rounded-full border border-border bg-popover px-2.5 py-1 text-ui-xs font-medium text-foreground shadow-sm"
            >
              {newArrivalCount} new notification
              {newArrivalCount === 1 ? "" : "s"}
            </button>
          )}
          {isEmpty ? (
            <div
              className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground"
              data-testid="notifications-empty"
            >
              <BellOff
                className="size-8 text-muted-foreground/45"
                aria-hidden
              />
              <div className="space-y-1">
                <p className="text-ui-sm text-muted-foreground/60">
                  You&apos;re all caught up
                </p>
                <p className="text-ui-xs text-muted-foreground/50">
                  New notifications will appear here.
                </p>
              </div>
            </div>
          ) : (
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
                        alwaysShowRail
                        onActivate={handleActivate}
                        onAcknowledge={handleAcknowledge}
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
                  onResetFilters={resetFilters}
                />
              </section>
            </>
          )}
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
    </TooltipProvider>
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
  readonly onResetFilters: () => void;
}

function RecentSectionBody(props: RecentSectionBodyProps): ReactNode {
  if (props.recentIds.length > 0) {
    return (
      <RecentRowList
        ids={props.recentIds}
        onActivate={props.onActivate}
        onAcknowledge={props.onAcknowledge}
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
          className="px-4 pt-2 pb-0.5 text-micro text-muted-foreground/60 first:pt-0"
        >
          {TEMPORAL_GROUP_LABEL[group]}
        </li>
      )}
      <NotificationRow
        feedId={props.feedId}
        alwaysShowRail={false}
        onActivate={props.onActivate}
        onAcknowledge={props.onAcknowledge}
      />
    </>
  );
}

function SectionLabel(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="mb-1 text-overline font-semibold uppercase tracking-wide text-muted-foreground">
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
