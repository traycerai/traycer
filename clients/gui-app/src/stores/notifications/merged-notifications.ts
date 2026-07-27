import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { notificationsMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  buildPayloadFromEvent,
  type NotificationPayload,
} from "@/lib/notifications";
import {
  categoryForNotificationSource,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";
import {
  classifyNotificationLifecycle,
  compareAttentionOrder,
  compareFeedIdAscending,
  type NotificationAttentionTier,
} from "@/lib/notifications/notification-lifecycle";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";
import {
  useAppLocalNotificationById,
  useAppLocalNotificationIds,
  useAppLocalNotificationUnreadCount,
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
import {
  type HostNotificationFeedEntry,
  selectHostNotificationAttentionCursor,
  selectHostNotificationRecentCursor,
  selectHostNotificationSummary,
  selectHostNotificationUnreadRecentCursor,
  selectHostNotificationUnreadRecentHasLoadedOnce,
  useHostNotificationById,
  useHostNotificationIds,
  useHostNotificationUnreadCount,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  useNotificationEntries,
  useNotificationEntryById,
  useNotificationEntryIds,
  useNotificationUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  formatHostNotificationPresentation,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationKnownPayload,
  type HostNotificationOutcome,
  type HostNotificationSeverity,
  type HostNotificationsAttentionCursor,
  type HostNotificationsChronologicalCursor,
} from "@traycer/protocol/host/notifications/contracts";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";
import { formatNotification } from "@traycer/protocol/notifications/notification-formatter";

export type MergedNotificationSource = "host" | "app-local" | "global";

export interface MergedNotificationRow {
  readonly feedId: string;
  readonly source: MergedNotificationSource;
  readonly sourceId: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly title: string;
  readonly body: string;
  readonly payload: NotificationPayload | null;
  readonly hostKind: HostNotificationFeedEntry["kind"] | null;
  readonly appLocalKind: AppLocalNotificationEntry["kind"] | null;
  readonly globalEntry: NotificationEntry | null;
  readonly severity: HostNotificationSeverity;
  readonly outcome: HostNotificationOutcome | null;
  /** Only host approval/interview rows carry a meaningful value; every other
   * row is `null` and never reads as an unresolved prompt. */
  readonly resolvedAt: number | null;
  /** Product-vocabulary category, mapped from `source` at the projection
   * boundary so consumers never branch on the internal source seam. */
  readonly category: NotificationCategory;
}

export interface MergedNotificationsActions {
  readonly markAsRead: (feedId: string) => void;
  readonly markAllAsRead: () => void;
  readonly loadMoreHost: () => void;
  readonly canLoadMoreHost: boolean;
  readonly isLoadingMoreHost: boolean;
  readonly hasHostLoadError: boolean;
  readonly loadMoreAttention: () => void;
  readonly canLoadMoreAttention: boolean;
  readonly isLoadingMoreAttention: boolean;
  readonly hasAttentionLoadError: boolean;
  readonly loadMoreUnreadRecent: () => void;
  readonly canLoadMoreUnreadRecent: boolean;
  readonly isLoadingMoreUnreadRecent: boolean;
  readonly hasUnreadRecentLoadError: boolean;
}

interface FeedCandidate {
  readonly feedId: string;
  readonly createdAt: number;
}

interface ParsedFeedId {
  readonly source: MergedNotificationSource;
  readonly sourceId: string;
}

interface HostNotificationMutationContext {
  readonly hostId: string | null;
  readonly snapshotEpoch: number;
  readonly liveLifecycleRevision: number;
}

export function hostFeedId(id: string): string {
  return `host:${id}`;
}

export function globalFeedId(id: string): string {
  return `global:${id}`;
}

export function appLocalFeedId(id: string): string {
  return `app-local:${id}`;
}

/** Newest-first; an ascending feed-id tie-break matches the host's SQLite
 * `id ASC` order so equal-timestamp rows don't disagree between the client
 * and host. */
function compareFeedCandidates(a: FeedCandidate, b: FeedCandidate): number {
  const createdAtDelta = b.createdAt - a.createdAt;
  if (createdAtDelta !== 0) return createdAtDelta;
  return compareFeedIdAscending(a.feedId, b.feedId);
}

export function mergedUnreadCount(input: {
  readonly hostUnread: number;
  readonly appLocalUnread: number;
  readonly globalUnread: number;
}): number {
  return input.hostUnread + input.appLocalUnread + input.globalUnread;
}

/** Every merged row, newest-first across all three sources - the shared base
 * the id/Attention/Recent projections all derive from without recomputing
 * their own source subscriptions. */
function useMergedNotificationRows(): ReadonlyArray<MergedNotificationRow> {
  const hostIds = useHostNotificationIds();
  const appLocalIds = useAppLocalNotificationIds();
  const globalIds = useNotificationEntryIds();
  const globalEntries = useNotificationEntries();
  const hostById = useHostNotificationsStore((state) => state.byId);
  const appLocalById = useAppLocalNotificationsStore((state) => state.byId);
  return useMemo(() => {
    const globalEntriesById = new Map(
      globalEntries.map((entry) => [entry.id, entry]),
    );
    const orderedGlobalEntries = globalIds
      .map((id) => globalEntriesById.get(id))
      .filter((entry): entry is NotificationEntry => entry !== undefined);
    const rows: MergedNotificationRow[] = [
      ...hostIds.map((id) => rowFromHostEntry(hostById[id])),
      ...appLocalIds.map((id) => rowFromAppLocalEntry(appLocalById[id])),
      ...orderedGlobalEntries.map((entry) => rowFromGlobalEntry(entry)),
    ];
    rows.sort(compareFeedCandidates);
    return rows;
  }, [hostIds, hostById, appLocalIds, appLocalById, globalIds, globalEntries]);
}

export function useMergedNotificationIds(): ReadonlyArray<string> {
  const rows = useMergedNotificationRows();
  return useMemo(() => rows.map((row) => row.feedId), [rows]);
}

export interface MergedNotificationOccurrenceEntry {
  readonly feedId: string;
  readonly occurrenceKey: string;
}

/** Full, unfiltered, newest-first occurrence order across every source and
 * section - the identity source live-arrival detection anchors against, so a
 * Recent filter that currently hides a row can never blind the arrival set to
 * it. Recurrence (same `feedId`, new `createdAt`) mints a new key; a
 * content-only retitle at the same `createdAt` keeps the same key. */
export function useMergedNotificationOccurrenceEntries(): ReadonlyArray<MergedNotificationOccurrenceEntry> {
  const rows = useMergedNotificationRows();
  return useMemo(
    () =>
      rows.map((row) => ({
        feedId: row.feedId,
        occurrenceKey: occurrenceKeyForNotification(row),
      })),
    [rows],
  );
}

interface AttentionOrderEntry {
  readonly row: MergedNotificationRow;
  readonly tier: NotificationAttentionTier;
}

/** Attention, blocking-first then failures, newest first within each tier.
 * Never filtered - Attention is complete and filter-invariant by design. */
export function useAttentionNotificationIds(): ReadonlyArray<string> {
  const rows = useMergedNotificationRows();
  return useMemo(() => {
    const attentionRows: AttentionOrderEntry[] = rows
      .map((row) => ({
        row,
        classification: classifyNotificationLifecycle(row),
      }))
      .filter(
        (
          entry,
        ): entry is {
          row: MergedNotificationRow;
          classification: {
            section: "attention";
            tier: NotificationAttentionTier;
          };
        } => entry.classification.section === "attention",
      )
      .map(({ row, classification }) => ({ row, tier: classification.tier }));
    attentionRows.sort((a, b) =>
      compareAttentionOrder(
        { tier: a.tier, createdAt: a.row.createdAt, feedId: a.row.feedId },
        { tier: b.tier, createdAt: b.row.createdAt, feedId: b.row.feedId },
      ),
    );
    return attentionRows.map((entry) => entry.row.feedId);
  }, [rows]);
}

/** Every non-attention row, chronological, filtered by the open-session
 * Unread-only/category selections. Attention rows are always excluded
 * regardless of filter state. */
export function useRecentNotificationIds(): ReadonlyArray<string> {
  const rows = useMergedNotificationRows();
  const unreadOnly = useNotificationsPopoverStore((state) => state.unreadOnly);
  const categories = useNotificationsPopoverStore((state) => state.categories);
  return useMemo(() => {
    return rows
      .filter((row) => classifyNotificationLifecycle(row).section === "recent")
      .filter((row) => categories.has(row.category))
      .filter((row) => !unreadOnly || row.readAt === null)
      .map((row) => row.feedId);
  }, [rows, unreadOnly, categories]);
}

export function useMergedNotificationRow(
  feedId: string,
): MergedNotificationRow | null {
  const parsed = parseFeedId(feedId);
  const hostEntry = useHostNotificationById(
    parsed?.source === "host" ? parsed.sourceId : "",
  );
  const appLocalEntry = useAppLocalNotificationById(
    parsed?.source === "app-local" ? parsed.sourceId : "",
  );
  const globalEntry = useNotificationEntryById(
    parsed?.source === "global" ? parsed.sourceId : "",
  );
  if (parsed === null) return null;
  if (parsed.source === "host") {
    return hostEntry === null ? null : rowFromHostEntry(hostEntry);
  }
  if (parsed.source === "app-local") {
    return appLocalEntry === null ? null : rowFromAppLocalEntry(appLocalEntry);
  }
  return globalEntry === null ? null : rowFromGlobalEntry(globalEntry);
}

export function useMergedNotificationUnreadCount(): number {
  const hostUnread = useHostNotificationUnreadCount();
  const appLocalUnread = useAppLocalNotificationUnreadCount();
  const globalUnread = useNotificationUnreadCount();
  return mergedUnreadCount({
    hostUnread,
    appLocalUnread,
    globalUnread,
  });
}

export type NotificationBellState =
  | { readonly kind: "unknown" }
  | { readonly kind: "clear" }
  | { readonly kind: "quietDot" }
  | { readonly kind: "attention"; readonly count: number };

/**
 * The bell's exact/quiet-dot/clear/unknown state. `unknown` wins outright
 * whenever the host summary is null - a partial-but-exact
 * collaboration/system contribution never gets promoted into a composite
 * number, per the "never present a stale/understated count as exact"
 * invariant.
 */
export function useNotificationBellState(): NotificationBellState {
  const hostSummary = useHostNotificationsStore(selectHostNotificationSummary);
  // App-local rows are always severity "failure" (`rowFromAppLocalEntry`
  // hardcodes it), so the app-local unread count already IS its
  // unread-failure count - no extra filter needed to fold it into attention.
  const appLocalUnread = useAppLocalNotificationUnreadCount();
  const globalUnread = useNotificationUnreadCount();
  if (hostSummary === null) return { kind: "unknown" };
  const attention = hostSummary.attentionCount + appLocalUnread;
  if (attention > 0) return { kind: "attention", count: attention };
  const unread = mergedUnreadCount({
    hostUnread: hostSummary.unreadCount,
    appLocalUnread,
    globalUnread,
  });
  return unread > 0 ? { kind: "quietDot" } : { kind: "clear" };
}

/** Screen-reader label matching the visual bell state exactly - never a bare
 * count with no state context. */
export function notificationBellAccessibleLabel(
  state: NotificationBellState,
): string {
  switch (state.kind) {
    case "unknown":
      return "Notifications, task notification status unavailable";
    case "clear":
      return "Notifications";
    case "quietDot":
      return "Notifications, unread activity";
    case "attention": {
      const noun =
        state.count === 1 ? "notification needs" : "notifications need";
      return `Notifications, ${state.count} ${noun} attention`;
    }
  }
}

export interface NotificationCenterHostState {
  readonly hostLabel: string | null;
  /** True when task activity cannot be shown as complete right now - either
   * there is no active host or its exact summary hasn't landed yet.
   * Collaboration/system rows remain valid and visible either way. */
  readonly isPartial: boolean;
}

/** Active-host subtitle/partial-state selector for the center header. */
export function useNotificationCenterHostState(): NotificationCenterHostState {
  const activeHostId = useReactiveActiveHostId();
  const hostEntry = useHostDirectoryEntry(activeHostId ?? "");
  const summary = useHostNotificationsStore(selectHostNotificationSummary);
  return {
    hostLabel: hostEntry?.label ?? null,
    isPartial: activeHostId === null || summary === null,
  };
}

export function useMergedNotificationsActions(): MergedNotificationsActions {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const globalMarkAsRead = useNotificationsStore((state) => state.markAsRead);
  const globalMarkAllAsRead = useNotificationsStore(
    (state) => state.markAllAsRead,
  );
  const appLocalMarkAsRead = useAppLocalNotificationsStore(
    (state) => state.markAsRead,
  );
  const appLocalMarkAllAsRead = useAppLocalNotificationsStore(
    (state) => state.markAllAsRead,
  );
  const hostNextCursor = useHostNotificationsStore(
    selectHostNotificationRecentCursor,
  );
  const hostAttentionCursor = useHostNotificationsStore(
    selectHostNotificationAttentionCursor,
  );
  const hostUnreadRecentCursor = useHostNotificationsStore(
    selectHostNotificationUnreadRecentCursor,
  );
  const unreadRecentHasLoadedOnce = useHostNotificationsStore(
    selectHostNotificationUnreadRecentHasLoadedOnce,
  );
  const hasHostLoadError = useHostNotificationsStore(
    (state) => state.recentStatus === "error",
  );
  const hasAttentionLoadError = useHostNotificationsStore(
    (state) => state.attentionStatus === "error",
  );
  const hasUnreadRecentLoadError = useHostNotificationsStore(
    (state) => state.unreadRecentStatus === "error",
  );

  const markHostRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.markRead",
    HostNotificationMutationContext,
    { readonly feedId: string; readonly sourceId: string }
  >({
    client,
    method: "host.notifications.markRead",
    mapVariables: (variables) => ({
      kind: "ids",
      ids: [variables.sourceId],
    }),
    options: {
      mutationKey: notificationsMutationKeys.markRead(),
      onMutate: () => captureHostNotificationMutationContext(client),
      onSuccess: (_data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .markReadLocally(
            [variables.sourceId],
            Date.now(),
            context.snapshotEpoch,
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't mark the notification as read.");
      },
    },
  });

  const markHostAllRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.markAllRead",
    HostNotificationMutationContext,
    { readonly beforeUpdatedAt: number }
  >({
    client,
    method: "host.notifications.markAllRead",
    mapVariables: (variables) => ({
      beforeUpdatedAt: variables.beforeUpdatedAt,
    }),
    options: {
      mutationKey: notificationsMutationKeys.markAllRead(),
      onMutate: () => captureHostNotificationMutationContext(client),
      onSuccess: (_data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .markAllReadLocally(
            variables.beforeUpdatedAt,
            Date.now(),
            context.snapshotEpoch,
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't mark notifications as read.");
      },
    },
  });

  const loadMoreHost = useHostMutation<
    HostRpcRegistry,
    "host.notifications.list",
    HostNotificationMutationContext,
    { readonly cursor: NonNullable<typeof hostNextCursor> }
  >({
    client,
    method: "host.notifications.list",
    mapVariables: (variables) => ({
      filter: "recent",
      limit: HOST_PAGE_LIMIT,
      cursor: variables.cursor,
    }),
    options: {
      mutationKey: notificationsMutationKeys.loadMore(),
      onMutate: () => beginHostNotificationMutation(client, "recent"),
      onSuccess: (data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        // Track only when the revision guard the merge itself applies would
        // also accept this response - a live lifecycle frame crossing this
        // request must not report success for a page the store discards.
        if (isCurrentHostNotificationPageMutation(client, context)) {
          trackNotificationPageLoadedSuccess(
            "recent",
            data.entries.length,
            data.nextCursor !== null,
          );
        }
        useHostNotificationsStore
          .getState()
          .mergeRecentPage(data.entries, asRecentCursor(data.nextCursor), {
            snapshotEpoch: context.snapshotEpoch,
            liveLifecycleRevision: context.liveLifecycleRevision,
            cursor: variables.cursor,
          });
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationPageMutation(client, context)) return;
        useHostNotificationsStore.getState().setPageStatus("recent", "error");
        trackNotificationPageLoadedFailure("recent");
        toastFromHostError(error, "Couldn't load older notifications.");
      },
    },
  });

  const loadMoreAttention = useHostMutation<
    HostRpcRegistry,
    "host.notifications.list",
    HostNotificationMutationContext,
    { readonly cursor: NonNullable<typeof hostAttentionCursor> }
  >({
    client,
    method: "host.notifications.list",
    mapVariables: (variables) => ({
      filter: "attention",
      limit: HOST_PAGE_LIMIT,
      cursor: variables.cursor,
    }),
    options: {
      mutationKey: notificationsMutationKeys.loadMoreAttention(),
      onMutate: () => beginHostNotificationMutation(client, "attention"),
      onSuccess: (data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        // Track only when the revision guard the merge itself applies would
        // also accept this response - a live lifecycle frame crossing this
        // request must not report success for a page the store discards.
        if (isCurrentHostNotificationPageMutation(client, context)) {
          trackNotificationPageLoadedSuccess(
            "attention",
            data.entries.length,
            data.nextCursor !== null,
          );
        }
        useHostNotificationsStore
          .getState()
          .mergeAttentionPage(
            data.entries,
            asAttentionCursor(data.nextCursor),
            {
              snapshotEpoch: context.snapshotEpoch,
              liveLifecycleRevision: context.liveLifecycleRevision,
              cursor: variables.cursor,
            },
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationPageMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .setPageStatus("attention", "error");
        trackNotificationPageLoadedFailure("attention");
        toastFromHostError(error, "Couldn't load more attention items.");
      },
    },
  });

  const loadMoreUnreadRecent = useHostMutation<
    HostRpcRegistry,
    "host.notifications.list",
    HostNotificationMutationContext,
    { readonly cursor: HostNotificationsChronologicalCursor | null }
  >({
    client,
    method: "host.notifications.list",
    mapVariables: (variables) => ({
      filter: "unreadRecent",
      limit: HOST_PAGE_LIMIT,
      cursor: variables.cursor ?? undefined,
    }),
    options: {
      mutationKey: notificationsMutationKeys.loadMoreUnreadRecent(),
      onMutate: () => beginHostNotificationMutation(client, "unreadRecent"),
      onSuccess: (data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        // Track only when the revision guard the merge itself applies would
        // also accept this response - a live lifecycle frame crossing this
        // request must not report success for a page the store discards.
        if (isCurrentHostNotificationPageMutation(client, context)) {
          trackNotificationPageLoadedSuccess(
            "recent",
            data.entries.length,
            data.nextCursor !== null,
          );
        }
        useHostNotificationsStore
          .getState()
          .mergeUnreadRecentPage(
            data.entries,
            asRecentCursor(data.nextCursor),
            {
              snapshotEpoch: context.snapshotEpoch,
              liveLifecycleRevision: context.liveLifecycleRevision,
              cursor: variables.cursor,
            },
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationPageMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .setPageStatus("unreadRecent", "error");
        trackNotificationPageLoadedFailure("recent");
        toastFromHostError(error, "Couldn't load more unread notifications.");
      },
    },
  });

  return useMemo(
    () => ({
      markAsRead: (feedId) => {
        const parsed = parseFeedId(feedId);
        if (parsed === null) return;
        if (parsed.source === "host") {
          if (client === null) return;
          markHostRead.mutate({
            feedId,
            sourceId: parsed.sourceId,
          });
          return;
        }
        if (parsed.source === "global") {
          globalMarkAsRead(parsed.sourceId);
          return;
        }
        appLocalMarkAsRead(parsed.sourceId, Date.now());
      },
      markAllAsRead: () => {
        globalMarkAllAsRead();
        appLocalMarkAllAsRead(Date.now());
        if (client !== null) {
          markHostAllRead.mutate({ beforeUpdatedAt: Date.now() });
        }
      },
      loadMoreHost: () => {
        if (hostNextCursor === null || client === null) return;
        loadMoreHost.mutate({ cursor: hostNextCursor });
      },
      canLoadMoreHost: hostNextCursor !== null && client !== null,
      isLoadingMoreHost: loadMoreHost.isPending,
      hasHostLoadError,
      loadMoreAttention: () => {
        if (hostAttentionCursor === null || client === null) return;
        loadMoreAttention.mutate({ cursor: hostAttentionCursor });
      },
      canLoadMoreAttention: hostAttentionCursor !== null && client !== null,
      isLoadingMoreAttention: loadMoreAttention.isPending,
      hasAttentionLoadError,
      // Unlike the other two tracks, a `null` cursor here is ambiguous on its
      // own between "never loaded" (Unread only just enabled) and
      // "exhausted" - the RPC's `cursor` is optional and starts a fresh first
      // page when omitted either way. `unreadRecentHasLoadedOnce` disambiguates
      // it: only once a page has actually loaded does a `null` cursor mean
      // genuine exhaustion.
      loadMoreUnreadRecent: () => {
        if (client === null) return;
        loadMoreUnreadRecent.mutate({ cursor: hostUnreadRecentCursor });
      },
      canLoadMoreUnreadRecent:
        client !== null &&
        (hostUnreadRecentCursor !== null || !unreadRecentHasLoadedOnce),
      isLoadingMoreUnreadRecent: loadMoreUnreadRecent.isPending,
      hasUnreadRecentLoadError,
    }),
    [
      globalMarkAsRead,
      globalMarkAllAsRead,
      appLocalMarkAsRead,
      appLocalMarkAllAsRead,
      markHostRead,
      markHostAllRead,
      loadMoreHost,
      hostNextCursor,
      hasHostLoadError,
      loadMoreAttention,
      hostAttentionCursor,
      hasAttentionLoadError,
      loadMoreUnreadRecent,
      hostUnreadRecentCursor,
      unreadRecentHasLoadedOnce,
      hasUnreadRecentLoadError,
      client,
    ],
  );
}

/** `host.notifications.list` always returns `nextCursor` in the requested
 * filter's cursor kind; the `recent` filter used for "load older" always
 * yields `chronological` (or `null`), never `attention`. */
function asRecentCursor(
  cursor:
    | HostNotificationsChronologicalCursor
    | HostNotificationsAttentionCursor
    | null,
): HostNotificationsChronologicalCursor | null {
  return cursor !== null && cursor.kind === "chronological" ? cursor : null;
}

/** Mirror of `asRecentCursor` for the `attention` filter, which always
 * yields an `attention` cursor (or `null`), never `chronological`. */
function asAttentionCursor(
  cursor:
    | HostNotificationsChronologicalCursor
    | HostNotificationsAttentionCursor
    | null,
): HostNotificationsAttentionCursor | null {
  return cursor !== null && cursor.kind === "attention" ? cursor : null;
}

/** `unreadRecent` pagination is a filtered view of Recent, not its own
 * analytics section - both collapse to `"recent"` so the section enum stays
 * the two values the tech plan names. */
function trackNotificationPageLoadedSuccess(
  section: "attention" | "recent",
  entryCount: number,
  hasMore: boolean,
): void {
  Analytics.getInstance().track(AnalyticsEvent.NotificationPageLoaded, {
    section,
    outcome: "success",
    result_count_bucket: analyticsCountBucket(entryCount),
    has_more: hasMore,
  });
}

function trackNotificationPageLoadedFailure(
  section: "attention" | "recent",
): void {
  Analytics.getInstance().track(AnalyticsEvent.NotificationPageLoaded, {
    section,
    outcome: "failure",
    result_count_bucket: null,
    has_more: null,
  });
}

export function rowFromHostEntry(
  entry: HostNotificationFeedEntry,
): MergedNotificationRow {
  const presentation = formatHostNotificationPresentation(entry);
  return {
    feedId: hostFeedId(entry.id),
    source: "host",
    sourceId: entry.id,
    createdAt: entry.updatedAt,
    readAt: entry.readAt,
    title: presentation.title,
    body: presentation.body,
    payload: payloadFromHostEntry(entry),
    hostKind: entry.kind,
    appLocalKind: null,
    globalEntry: null,
    severity: entry.severity,
    outcome: entry.outcome,
    resolvedAt: "resolvedAt" in entry ? entry.resolvedAt : null,
    category: categoryForNotificationSource("host"),
  };
}

export function rowFromAppLocalEntry(
  entry: AppLocalNotificationEntry,
): MergedNotificationRow {
  return {
    feedId: appLocalFeedId(entry.id),
    source: "app-local",
    sourceId: entry.id,
    createdAt: entry.updatedAt,
    readAt: entry.readAt,
    title: entry.message,
    body: entry.detail ?? "Traycer notification",
    payload: entry.payload,
    hostKind: null,
    appLocalKind: entry.kind,
    globalEntry: null,
    severity: "failure",
    outcome: null,
    resolvedAt: null,
    category: categoryForNotificationSource("app-local"),
  };
}

export function rowFromGlobalEntry(
  entry: NotificationEntry,
): MergedNotificationRow {
  return {
    feedId: globalFeedId(entry.id),
    source: "global",
    sourceId: entry.id,
    createdAt: entry.createdAt,
    readAt: entry.readAt,
    title: formatNotification(entry.event, undefined),
    body: "Collaboration",
    payload: buildPayloadFromEvent(entry.event),
    hostKind: null,
    appLocalKind: null,
    globalEntry: entry,
    severity: "info",
    outcome: null,
    resolvedAt: null,
    category: categoryForNotificationSource("global"),
  };
}

function parseFeedId(feedId: string): ParsedFeedId | null {
  const delimiterIndex = feedId.indexOf(":");
  if (delimiterIndex <= 0) return null;
  const source = feedId.slice(0, delimiterIndex);
  const sourceId = feedId.slice(delimiterIndex + 1);
  if (sourceId.length === 0) return null;
  if (source === "host" || source === "app-local" || source === "global") {
    return { source, sourceId };
  }
  return null;
}

function captureHostNotificationMutationContext(
  client: HostClient<HostRpcRegistry> | null,
): HostNotificationMutationContext {
  const state = useHostNotificationsStore.getState();
  return {
    hostId: client?.getActiveHostId() ?? null,
    snapshotEpoch: state.snapshotEpoch,
    liveLifecycleRevision: state.liveLifecycleRevision,
  };
}

/** Marks the track "loading" for the recoverable inline error/retry surface,
 * then captures the same stale-rejection context every merge/error path
 * already gates on. */
function beginHostNotificationMutation(
  client: HostClient<HostRpcRegistry> | null,
  track: "attention" | "recent" | "unreadRecent",
): HostNotificationMutationContext {
  useHostNotificationsStore.getState().setPageStatus(track, "loading");
  return captureHostNotificationMutationContext(client);
}

function isCurrentHostNotificationMutation(
  client: HostClient<HostRpcRegistry> | null,
  context: HostNotificationMutationContext | undefined,
): context is HostNotificationMutationContext {
  if (context === undefined) return false;
  if (
    useHostNotificationsStore.getState().snapshotEpoch !== context.snapshotEpoch
  ) {
    return false;
  }
  return (client?.getActiveHostId() ?? null) === context.hostId;
}

/** Page-load error eligibility, scoped to the three `attention`/`recent`/
 * `unreadRecent` load-more tracks only - NOT used by markRead/markAllRead,
 * whose acknowledgment semantics don't depend on `liveLifecycleRevision`
 * staying put. Their matching success path (`mergeXPage`) already rejects a
 * crossed `liveLifecycleRevision` before merging; without this, an error
 * whose request started before an intervening live frame could still set the
 * page status to "error" even though the equivalent success would have been
 * discarded as stale. */
function isCurrentHostNotificationPageMutation(
  client: HostClient<HostRpcRegistry> | null,
  context: HostNotificationMutationContext | undefined,
): context is HostNotificationMutationContext {
  if (!isCurrentHostNotificationMutation(client, context)) return false;
  return (
    useHostNotificationsStore.getState().liveLifecycleRevision ===
    context.liveLifecycleRevision
  );
}

function payloadFromHostEntry(
  entry: HostNotificationFeedEntry,
): NotificationPayload | null {
  // Second-stage semantic parse: the known payload schemas are the ONLY
  // contract - a payload this build understands, under its matching row
  // kind, maps to a typed navigation target compile-linked to the producer
  // schemas; anything else (a payload from a newer host, a malformed row, or
  // a cross-kind contradiction) renders generically with no deep-link.
  // Degrade, never error.
  const known = parseKnownHostNotificationPayloadForKind(
    entry.kind,
    entry.payload,
  );
  return known === null ? null : navigationPayloadFromKnown(known);
}

function navigationPayloadFromKnown(
  known: HostNotificationKnownPayload,
): NotificationPayload | null {
  switch (known.kind) {
    case "chat":
      return {
        kind: "chat",
        epicId: known.epicId,
        chatId: known.chatId ?? undefined,
      };
    case "agent_stalled":
      return { kind: "chat", epicId: known.epicId, chatId: known.chatId };
    case "workspace_operation_failed":
      return { kind: "chat", epicId: known.epicId, chatId: known.chatId };
    case "epic":
      return { kind: "epic", epicId: known.epicId };
    case "approval":
      return {
        kind: "approval",
        epicId: known.epicId,
        chatId: known.chatId,
        approvalId: known.approvalId,
        sessionId: undefined,
        artifactId: undefined,
      };
    case "interview":
      return {
        kind: "interview",
        epicId: known.epicId,
        chatId: known.chatId,
        interviewBlockId: known.interviewBlockId,
      };
  }
}

const HOST_PAGE_LIMIT = 50;
