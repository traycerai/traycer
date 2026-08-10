import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
  notificationEntityFromHostEntry,
  type NotificationPayload,
} from "@/lib/notifications";
import {
  invalidateNotificationIndicators,
  invalidateNotificationIndicatorsForEntities,
} from "@/lib/notifications/notification-indicator-cache";
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
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import { requestCloudEntityRead } from "@/lib/notifications/cloud-entity-read-driver";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
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
  type HostNotificationsResolveRequest,
  type HostNotificationsCloudFeedRow,
  type HostNotificationsCloudFeedEntryRequest,
  type HostNotificationsCloudFeedMarkAllReadRequest,
  type HostNotificationsCloudFeedClearAllRequest,
  type HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";
import { formatNotification } from "@traycer/protocol/notifications/notification-formatter";

export type MergedNotificationSource =
  "host" | "app-local" | "global" | "cloud";

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
  /** The host entry's `sourceRef` (approval/interview id), part of the
   * dismiss occurrence token `(id, updatedAt, sourceRef)`. `null` for
   * non-host rows and host rows without a source ref. */
  readonly sourceRef: string | null;
  /** The machine the notification happened on. Display and NAVIGATION only:
   * a cloud approval must open on its owning host, never on whichever host
   * relayed the feed. Feed mutations never use it - they address the entry.
   * `null` for rows with no meaningful origin. */
  readonly originHostId: string | null;
  /** Product-vocabulary category, mapped from `source` at the projection
   * boundary so consumers never branch on the internal source seam. */
  readonly category: NotificationCategory;
}

function isHostUnsupportedError(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

export interface MergedNotificationsActions {
  readonly markAsRead: (row: MergedNotificationRow | string) => void;
  /** Dismiss an unresolved `needs_action` Attention row: stamps `resolvedAt`
   * (and marks it read) so it leaves Attention without answering the
   * underlying prompt. Takes the row (not just its id) because the request
   * carries the immutable occurrence token `(id, updatedAt)`. Host rows only -
   * no other source is blocking-eligible. */
  readonly resolve: (row: MergedNotificationRow) => void;
  readonly clear: (row: MergedNotificationRow) => void;
  readonly clearAll: () => void;
  readonly markAllAsRead: () => void;
  /**
   * View consumption for one entity - the cloud counterpart of the v1
   * `host.notifications.markRead {kind:"entity"}` RPC, which in cloud mode
   * addresses rows the connected host may not even hold.
   *
   * Cloud mode only: local mode keeps issuing the host RPC from the session
   * provider, because there the host's own SQLite is the authority being
   * consumed. No-op in every other mode.
   */
  readonly markEntityAsRead: (entity: HostNotificationsEntityRef) => void;
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

interface CloudFeedMutationContext {
  readonly hostId: string | null;
  readonly sessionEpoch: number;
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
  const feedMode = useNotificationFeedMode();
  const activeHostId = useReactiveActiveHostId();
  const hostIds = useHostNotificationIds();
  const appLocalIds = useAppLocalNotificationIds();
  const globalIds = useNotificationEntryIds();
  const globalEntries = useNotificationEntries();
  const hostById = useHostNotificationsStore((state) => state.byId);
  const appLocalById = useAppLocalNotificationsStore((state) => state.byId);
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  return useMemo(() => {
    if (feedMode === "cloud") {
      const rows = Object.values(cloudRows)
        .filter(
          (row): row is HostNotificationsCloudFeedRow => row !== undefined,
        )
        .map(rowFromCloudFeedRow);
      rows.sort(compareFeedCandidates);
      return rows;
    }
    if (feedMode === "upgrade-required") return [];
    const globalEntriesById = new Map(
      globalEntries.map((entry) => [entry.id, entry]),
    );
    const orderedGlobalEntries = globalIds
      .map((id) => globalEntriesById.get(id))
      .filter((entry): entry is NotificationEntry => entry !== undefined);
    const rows: MergedNotificationRow[] = [
      ...hostIds.map((id) =>
        rowFromHostEntryForOrigin(hostById[id], activeHostId),
      ),
      ...appLocalIds.map((id) => rowFromAppLocalEntry(appLocalById[id])),
      ...orderedGlobalEntries.map((entry) => rowFromGlobalEntry(entry)),
    ];
    rows.sort(compareFeedCandidates);
    return rows;
  }, [
    feedMode,
    cloudRows,
    hostIds,
    hostById,
    appLocalIds,
    appLocalById,
    globalIds,
    globalEntries,
    activeHostId,
  ]);
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

function rowFromLocalFeedId(input: {
  readonly parsed: ParsedFeedId;
  readonly feedMode: "local" | "cloud" | "upgrade-required";
  readonly hostEntry: HostNotificationFeedEntry | null;
  readonly appLocalEntry: AppLocalNotificationEntry | null;
  readonly globalEntry: NotificationEntry | null;
  readonly hostOriginId: string | null;
}): MergedNotificationRow | null {
  if (input.feedMode !== "local") return null;
  switch (input.parsed.source) {
    case "host":
      return input.hostEntry === null
        ? null
        : rowFromHostEntryForOrigin(input.hostEntry, input.hostOriginId);
    case "app-local":
      return input.appLocalEntry === null
        ? null
        : rowFromAppLocalEntry(input.appLocalEntry);
    case "global":
      return input.globalEntry === null
        ? null
        : rowFromGlobalEntry(input.globalEntry);
    case "cloud":
      return null;
  }
}

function rowFromCloudFeedId(input: {
  readonly feedMode: "local" | "cloud" | "upgrade-required";
  readonly cloudRow: HostNotificationsCloudFeedRow | undefined;
}): MergedNotificationRow | null {
  if (input.feedMode !== "cloud" || input.cloudRow === undefined) return null;
  return rowFromCloudFeedRow(input.cloudRow);
}

export function useMergedNotificationRow(
  feedId: string,
): MergedNotificationRow | null {
  const feedMode = useNotificationFeedMode();
  const activeHostId = useReactiveActiveHostId();
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
  const cloudRow = useCloudNotificationsStore((state) => state.rows[feedId]);
  if (parsed === null) return null;
  if (parsed.source === "cloud") {
    return rowFromCloudFeedId({ feedMode, cloudRow });
  }
  return rowFromLocalFeedId({
    parsed,
    feedMode,
    hostEntry,
    appLocalEntry,
    globalEntry,
    hostOriginId: activeHostId,
  });
}

export function useMergedNotificationUnreadCount(): number {
  const feedMode = useNotificationFeedMode();
  const hostUnread = useHostNotificationUnreadCount();
  const appLocalUnread = useAppLocalNotificationUnreadCount();
  const globalUnread = useNotificationUnreadCount();
  const cloudSummary = useCloudNotificationsStore((state) => state.summary);
  if (feedMode === "cloud") return cloudSummary?.unreadCount ?? 0;
  if (feedMode === "upgrade-required") return 0;
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
 *
 * `unknown` renders identically to `clear` (no dot, plain bell) - a bare gray
 * dot with no path forward was confusing whether the cause was "still
 * connecting" or "this host will never support notifications". It stays a
 * distinct kind rather than folding into `clear` outright because analytics
 * still needs to bucket "confirmed zero" separately from "we don't know" (see
 * the open-lifecycle tracking in `notifications-bell.tsx`).
 */
export function useNotificationBellState(): NotificationBellState {
  const feedMode = useNotificationFeedMode();
  const hostSummary = useHostNotificationsStore(selectHostNotificationSummary);
  // App-local rows are always severity "failure" (`rowFromAppLocalEntry`
  // hardcodes it), so the app-local unread count already IS its
  // unread-failure count - no extra filter needed to fold it into attention.
  const appLocalUnread = useAppLocalNotificationUnreadCount();
  const globalUnread = useNotificationUnreadCount();
  const cloudSummary = useCloudNotificationsStore((state) => state.summary);
  if (feedMode === "cloud") {
    if (cloudSummary === null) return { kind: "unknown" };
    if (cloudSummary.attentionCount > 0) {
      return { kind: "attention", count: cloudSummary.attentionCount };
    }
    return cloudSummary.unreadCount > 0
      ? { kind: "quietDot" }
      : { kind: "clear" };
  }
  if (feedMode === "upgrade-required") return { kind: "clear" };
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
 * count with no state context. `unknown` shares `clear`'s label since both
 * render the same plain bell with no indicator. */
export function notificationBellAccessibleLabel(
  state: NotificationBellState,
): string {
  switch (state.kind) {
    case "unknown":
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
  const feedMode = useNotificationFeedMode();
  const localSummary = useHostNotificationsStore(selectHostNotificationSummary);
  const cloudSummary = useCloudNotificationsStore((state) => state.summary);
  // The cloud relay is the complete authority once the host confirms support.
  // The v1 replica is intentionally discarded at the mode boundary, so using
  // its null summary here would make an exact cloud feed look perpetually cold.
  const summary = feedMode === "cloud" ? cloudSummary : localSummary;
  return {
    hostLabel: hostEntry?.label ?? null,
    isPartial: activeHostId === null || summary === null,
  };
}

export function useMergedNotificationsActions(): MergedNotificationsActions {
  const feedMode = useNotificationFeedMode();
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const queryClient = useQueryClient();
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
  const cloudVersion = useCloudNotificationsStore((state) => state.version);

  const markCloudUnavailable = (): void => {
    useCloudNotificationsStore.getState().setConnectionState("unavailable");
  };
  const handleCloudMutationResult = (data: {
    readonly status: "applied" | "unavailable";
  }): void => {
    if (data.status === "unavailable") markCloudUnavailable();
  };
  const captureCloudMutationContext = useCallback(
    (): CloudFeedMutationContext => ({
      hostId: client?.getActiveHostId() ?? null,
      sessionEpoch: useCloudNotificationsStore.getState().sessionEpoch,
    }),
    [client],
  );
  const isCurrentCloudMutation = useCallback(
    (context: CloudFeedMutationContext): boolean =>
      client?.getActiveHostId() === context.hostId &&
      useCloudNotificationsStore.getState().sessionEpoch ===
        context.sessionEpoch,
    [client],
  );
  const cloudMarkRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.cloudFeed.markRead",
    CloudFeedMutationContext,
    HostNotificationsCloudFeedEntryRequest
  >({
    client,
    method: "host.notifications.cloudFeed.markRead",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.cloudMarkRead(),
      onMutate: captureCloudMutationContext,
      onSuccess: (data, _variables, context) => {
        if (isCurrentCloudMutation(context)) {
          handleCloudMutationResult(data);
        }
      },
      onError: (_error, _variables, context) => {
        if (context !== undefined && isCurrentCloudMutation(context)) {
          markCloudUnavailable();
        }
      },
    },
  });
  const cloudMarkAllRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.cloudFeed.markAllRead",
    CloudFeedMutationContext,
    HostNotificationsCloudFeedMarkAllReadRequest
  >({
    client,
    method: "host.notifications.cloudFeed.markAllRead",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.cloudMarkAllRead(),
      onMutate: captureCloudMutationContext,
      onSuccess: (data, _variables, context) => {
        if (!isCurrentCloudMutation(context)) return;
        if (data.status === "applied") {
          handleCloudMutationResult({ status: "applied" });
        } else if (data.status === "unavailable") {
          handleCloudMutationResult({ status: "unavailable" });
        }
      },
      onError: (error, _variables, context) => {
        // This is an optional RPC. Older cloud relays still support the
        // established per-entry write used by the compatibility fallback.
        if (isHostUnsupportedError(error)) return;
        if (context !== undefined && isCurrentCloudMutation(context)) {
          markCloudUnavailable();
        }
      },
    },
  });
  const cloudResolve = useHostMutation<
    HostRpcRegistry,
    "host.notifications.cloudFeed.resolve",
    CloudFeedMutationContext,
    HostNotificationsCloudFeedEntryRequest
  >({
    client,
    method: "host.notifications.cloudFeed.resolve",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.cloudResolve(),
      onMutate: captureCloudMutationContext,
      onSuccess: (data, _variables, context) => {
        if (isCurrentCloudMutation(context)) {
          handleCloudMutationResult(data);
        }
      },
      onError: (_error, _variables, context) => {
        if (context !== undefined && isCurrentCloudMutation(context)) {
          markCloudUnavailable();
        }
      },
    },
  });
  const cloudClear = useHostMutation<
    HostRpcRegistry,
    "host.notifications.cloudFeed.clear",
    CloudFeedMutationContext,
    HostNotificationsCloudFeedEntryRequest
  >({
    client,
    method: "host.notifications.cloudFeed.clear",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.cloudClear(),
      onMutate: captureCloudMutationContext,
      onSuccess: (data, _variables, context) => {
        if (isCurrentCloudMutation(context)) {
          handleCloudMutationResult(data);
        }
      },
      onError: (_error, _variables, context) => {
        if (context !== undefined && isCurrentCloudMutation(context)) {
          markCloudUnavailable();
        }
      },
    },
  });
  const cloudClearAll = useHostMutation<
    HostRpcRegistry,
    "host.notifications.cloudFeed.clearAll",
    CloudFeedMutationContext,
    HostNotificationsCloudFeedClearAllRequest
  >({
    client,
    method: "host.notifications.cloudFeed.clearAll",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.cloudClearAll(),
      onMutate: captureCloudMutationContext,
      onSuccess: (data, _variables, context) => {
        if (isCurrentCloudMutation(context)) {
          handleCloudMutationResult(data);
        }
      },
      onError: (_error, _variables, context) => {
        if (context !== undefined && isCurrentCloudMutation(context)) {
          markCloudUnavailable();
        }
      },
    },
  });

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
        // Tab/sidebar indicators are otherwise refreshed only by this row's
        // `readStateChanged` echo on the feed stream; invalidate here too so
        // a successful mark-read clears them over the unary channel even
        // while that stream is down.
        invalidateIndicatorsForHostRow(
          queryClient,
          client,
          context.hostId,
          variables.sourceId,
        );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't mark the notification as read.");
      },
    },
  });

  const resolveHost = useHostMutation<
    HostRpcRegistry,
    "host.notifications.resolve",
    HostNotificationMutationContext,
    {
      readonly feedId: string;
      readonly sourceId: string;
      readonly updatedAt: number;
      readonly sourceRef: string | null;
    }
  >({
    client,
    method: "host.notifications.resolve",
    // Immutable occurrence token `(id, updatedAt, sourceRef)` - the host
    // resolves only if this exact occurrence is still the unresolved row, so a
    // newer prompt that reopened the same reusable id is never clobbered, even
    // when it reopened within the same millisecond (equal `updatedAt`, new
    // `sourceRef`).
    mapVariables: (variables) => ({
      occurrences: [
        {
          id: variables.sourceId,
          updatedAt: variables.updatedAt,
          sourceRef: variables.sourceRef,
        },
      ],
    }),
    options: {
      mutationKey: notificationsMutationKeys.resolve(),
      onMutate: () => captureHostNotificationMutationContext(client),
      // No optimistic local write. The host stamps one authoritative
      // `resolvedAt`/`readAt` and emits it as a non-suppressed
      // `readStateChanged` frame, which is the single source that removes the
      // row from Attention (and a fresh snapshot reconciles it on reconnect). A
      // client-side write would either diverge from that timestamp or resolve a
      // NEWER occurrence that reopened the same id between capture and success;
      // if the occurrence has moved on, the host no-ops and emits nothing, so
      // the row correctly stays in Attention.
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't dismiss the notification.");
      },
    },
  });

  const resolveHostAll = useHostMutation<
    HostRpcRegistry,
    "host.notifications.resolve",
    HostNotificationMutationContext,
    HostNotificationsResolveRequest
  >({
    client,
    method: "host.notifications.resolve",
    // Batch dismiss for the "Mark all read" double-tick: the SAME token-guarded
    // `host.notifications.resolve` path the row-level Dismiss uses, called with
    // the currently-loaded Attention occurrence tokens. Zero new wire surface -
    // the request already batches (depth-safe-chunked host-side).
    mapVariables: (variables) => variables,
    options: {
      mutationKey: notificationsMutationKeys.resolveAll(),
      onMutate: () => captureHostNotificationMutationContext(client),
      // No optimistic write (same as the row-level resolve): the rows leave
      // Attention via the host's authoritative `readStateChanged` frame.
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        // On an older host the resolve method is `E_HOST_UNSUPPORTED`: the
        // shared mapper surfaces upgrade guidance and creates no failure row,
        // and its per-code dedupe collapses this with markAllRead's toast if
        // that also degraded - so the partial degrade never double-toasts.
        toastFromHostError(error, "Couldn't dismiss the notifications.");
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
        // Same stream-independence rationale as the row-level mark-read; a
        // mark-all has no entity list, so the whole host scope refetches.
        if (context.hostId !== null) {
          invalidateNotificationIndicators(queryClient, context.hostId, client);
        }
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
      markAsRead: (target) => {
        const feedId = typeof target === "string" ? target : target.feedId;
        const parsed = parseFeedId(feedId);
        if (parsed === null) return;
        if (parsed.source === "cloud") {
          if (feedMode !== "cloud" || typeof target === "string") return;
          useCloudNotificationsStore
            .getState()
            .markReadLocally(target.sourceId, Date.now());
          cloudMarkRead.mutate({ entryId: target.sourceId });
          return;
        }
        if (feedMode !== "local") return;
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
      resolve: (row) => {
        if (row.source === "cloud") {
          if (feedMode !== "cloud") return;
          cloudResolve.mutate({ entryId: row.sourceId });
          return;
        }
        if (feedMode !== "local") return;
        // Only host `needs_action` rows are dismiss-eligible (app-local rows
        // are `failure`, global rows are `info` - neither reaches the blocking
        // tier), so this is host-only by construction. `row.createdAt` is the
        // host entry's `updatedAt` - the occurrence token the host guards on.
        if (row.source !== "host") return;
        // A retained-but-disconnected host keeps `client !== null` while its
        // active host id drops to null; firing resolve then only yields an
        // unbound-rejection toast while the row cannot change. Gate on the same
        // authoritative active-host signal `markAllAsRead`'s dismiss-all half
        // uses, NOT `client !== null`.
        if (client === null || client.getActiveHostId() === null) return;
        resolveHost.mutate({
          feedId: row.feedId,
          sourceId: row.sourceId,
          updatedAt: row.createdAt,
          sourceRef: row.sourceRef,
        });
      },
      markAllAsRead: () => {
        if (feedMode === "cloud" && cloudVersion !== null) {
          // `cloudVersion` belongs to the rendered action closure, whereas a
          // frame can update the store before the click reaches this handler.
          // Do not locally consume rows that the versioned bulk command will
          // deliberately leave unread.
          const cloudState = useCloudNotificationsStore.getState();
          if (cloudState.version !== cloudVersion) return;
          const fallbackEntryIds = Object.values(cloudState.rows)
            .filter(
              (row): row is HostNotificationsCloudFeedRow =>
                row !== undefined && row.entry.readAt === null,
            )
            .map((row) => row.entryId);
          const fallbackContext = captureCloudMutationContext();
          cloudState.markAllReadLocally(Date.now());
          const fallBackToEntryMutations = async (): Promise<void> => {
            // An older cloud server cannot atomically include rows it did not
            // render, but it can preserve the released per-entry behavior for
            // every renderable row.
            for (const entryId of fallbackEntryIds) {
              if (!isCurrentCloudMutation(fallbackContext)) return;
              try {
                await cloudMarkRead.mutateAsync({ entryId });
              } catch {
                // Each per-entry marker is independent and idempotent. A
                // transient failure must not prevent later entries from being
                // persisted on the older relay.
                continue;
              }
            }
          };
          void cloudMarkAllRead
            .mutateAsync({ observedVersion: cloudVersion })
            .then(async (result) => {
              if (result.status === "unsupported") {
                await fallBackToEntryMutations();
              }
            })
            .catch(async (error: unknown) => {
              if (!isHostUnsupportedError(error)) return;
              await fallBackToEntryMutations();
            });
          return;
        }
        if (feedMode !== "local") return;
        globalMarkAllAsRead();
        appLocalMarkAllAsRead(Date.now());
        // Both host halves - mark-all-read AND dismiss-all - apply only against
        // an ACTIVE host. A disconnect keeps the runtime binding
        // (`client !== null`) and the retained host replica, but drops the
        // active host id to null and degrades the exact summary to unknown;
        // firing host mutations then only yields unbound-rejection error toasts
        // while the rendered rows cannot change. Gate BOTH on the same
        // authoritative active-host signal (read fresh at click time, the same
        // value `useReactiveActiveHostId` projects), NOT `client !== null`. The
        // local global/app-local mark-all above always run.
        if (client !== null && client.getActiveHostId() !== null) {
          // Fire mark-all-read and dismiss-all CONCURRENTLY. mark-all-read is
          // unchanged (released `markAllRead` semantics - a released client's
          // plain mark-all must never start resolving prompts host-side). The
          // dismiss-all portion is pure client-side composition: it resolves
          // the currently-loaded blocking-tier Attention rows (host
          // `needs_action`, still unresolved) through the same occurrence-token
          // guarded `resolve` path the row-level Dismiss uses.
          //
          // Only LOADED rows are dismissed. `needs_action` rows beyond the
          // Attention pagination boundary are intentionally NOT dismissed
          // ("you can't dismiss what you haven't seen") - a host-side
          // resolve-all would violate the token discipline by dismissing
          // prompts the user never saw, including ones arriving this instant.
          //
          // If the host predates `resolve` the dismiss degrades with an upgrade
          // toast (no failure row) while mark-all-read still applies; the
          // loaded needs_action rows simply stay in Attention.
          markHostAllRead.mutate({ beforeUpdatedAt: Date.now() });
          const occurrences = loadedBlockingAttentionOccurrences();
          // The protocol requires >= 1 occurrence, so skip the RPC entirely
          // when no blocking Attention rows are loaded.
          if (occurrences.length > 0) {
            resolveHostAll.mutate({ occurrences });
          }
        }
      },
      markEntityAsRead: (entity) => {
        if (feedMode !== "cloud") return;
        // Selection, single-flight, backoff and the retry timer all live in
        // the driver: they have to outlive this render and stay single-flight
        // across every caller. There is no cloud mark-many RPC, so the driver
        // serializes per entry the way `markAllAsRead` does.
        requestCloudEntityRead(entity, {
          markRead: async (entryId) => {
            const result = await cloudMarkRead.mutateAsync({ entryId });
            // `unavailable` is a refusal, not a transport failure - the
            // mutation resolves, so the driver has to be told explicitly or it
            // would record a success the server never performed.
            if (result.status === "unavailable") {
              throw new Error("cloud feed unavailable");
            }
          },
          now: () => Date.now(),
          random: () => Math.random(),
        });
      },
      clear: (row) => {
        if (row.source !== "cloud" || feedMode !== "cloud") return;
        cloudClear.mutate({ entryId: row.sourceId });
      },
      clearAll: () => {
        if (feedMode !== "cloud" || cloudVersion === null) return;
        // Send the version of the snapshot the user is LOOKING AT, not
        // whatever the cloud head has reached by the time this lands. The
        // fan-out then covers exactly the rows on screen, and an entry that
        // arrives in between survives however many times a lost-response
        // retry replays this call.
        cloudClearAll.mutate({ observedVersion: cloudVersion });
      },
      loadMoreHost: () => {
        if (feedMode !== "local") return;
        if (hostNextCursor === null || client === null) return;
        loadMoreHost.mutate({ cursor: hostNextCursor });
      },
      canLoadMoreHost:
        feedMode === "local" && hostNextCursor !== null && client !== null,
      isLoadingMoreHost: loadMoreHost.isPending,
      hasHostLoadError,
      loadMoreAttention: () => {
        if (feedMode !== "local") return;
        if (hostAttentionCursor === null || client === null) return;
        loadMoreAttention.mutate({ cursor: hostAttentionCursor });
      },
      canLoadMoreAttention:
        feedMode === "local" && hostAttentionCursor !== null && client !== null,
      isLoadingMoreAttention: loadMoreAttention.isPending,
      hasAttentionLoadError,
      // Unlike the other two tracks, a `null` cursor here is ambiguous on its
      // own between "never loaded" (Unread only just enabled) and
      // "exhausted" - the RPC's `cursor` is optional and starts a fresh first
      // page when omitted either way. `unreadRecentHasLoadedOnce` disambiguates
      // it: only once a page has actually loaded does a `null` cursor mean
      // genuine exhaustion.
      loadMoreUnreadRecent: () => {
        if (feedMode !== "local") return;
        if (client === null) return;
        loadMoreUnreadRecent.mutate({ cursor: hostUnreadRecentCursor });
      },
      canLoadMoreUnreadRecent:
        feedMode === "local" &&
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
      resolveHost,
      resolveHostAll,
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
      feedMode,
      cloudVersion,
      captureCloudMutationContext,
      isCurrentCloudMutation,
      cloudMarkRead,
      cloudMarkAllRead,
      cloudResolve,
      cloudClear,
      cloudClearAll,
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
  return rowFromHostEntryForOrigin(entry, null);
}

/** The v1 host store is scoped to the connected host. Preserve that source
 * identity in interactive row projections so approval/interview routing never
 * guesses across hosts. The legacy public formatter remains host-less for
 * native display callers that pass origin separately in their envelope. */
function rowFromHostEntryForOrigin(
  entry: HostNotificationFeedEntry,
  originHostId: string | null,
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
    sourceRef: entry.sourceRef,
    originHostId,
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
    sourceRef: null,
    originHostId: null,
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
    sourceRef: null,
    originHostId: null,
    category: categoryForNotificationSource("global"),
  };
}

export function rowFromCloudFeedRow(
  row: HostNotificationsCloudFeedRow,
): MergedNotificationRow {
  const fallback = formatHostNotificationPresentation(row.entry);
  const title =
    row.presentation.chatTitle ?? row.presentation.epicTitle ?? fallback.title;
  return {
    feedId: cloudNotificationFeedId(row.entryId),
    source: "cloud",
    // `sourceId` IS the `entryId` - the one thing every cloud mutation needs.
    sourceId: row.entryId,
    createdAt: row.entry.updatedAt,
    readAt: row.entry.readAt,
    title,
    body: fallback.body,
    payload: payloadFromHostEntry(row.entry),
    hostKind: row.entry.kind,
    appLocalKind: null,
    globalEntry: null,
    severity: row.entry.severity,
    outcome: row.entry.outcome,
    resolvedAt: "resolvedAt" in row.entry ? row.entry.resolvedAt : null,
    sourceRef: row.entry.sourceRef,
    originHostId: row.originHostId,
    category: categoryForNotificationSource("cloud"),
  };
}

function parseFeedId(feedId: string): ParsedFeedId | null {
  const delimiterIndex = feedId.indexOf(":");
  if (delimiterIndex <= 0) return null;
  const source = feedId.slice(0, delimiterIndex);
  const sourceId = feedId.slice(delimiterIndex + 1);
  if (sourceId.length === 0) return null;
  if (
    source === "host" ||
    source === "app-local" ||
    source === "global" ||
    source === "cloud"
  ) {
    return { source, sourceId };
  }
  return null;
}

/** The occurrence tokens of the currently-loaded blocking-tier Attention rows -
 * host `needs_action` rows that are still unresolved, i.e. exactly the set the
 * row-level Dismiss resolves, gathered for the "Mark all read" double-tick's
 * dismiss-all composition. Reads the loaded replica only; unloaded rows past the
 * Attention pagination boundary are intentionally excluded (see the note in
 * `markAllAsRead` - occurrence-token discipline forbids resolving unseen
 * prompts). */
function loadedBlockingAttentionOccurrences(): HostNotificationsResolveRequest["occurrences"] {
  return Object.values(useHostNotificationsStore.getState().byId)
    .filter(
      (entry) =>
        entry.severity === "needs_action" &&
        "resolvedAt" in entry &&
        entry.resolvedAt === null,
    )
    .map((entry) => ({
      id: entry.id,
      updatedAt: entry.updatedAt,
      sourceRef: entry.sourceRef,
    }));
}

/** Entity-scoped indicator invalidation for one acknowledged host row. A row
 * already pruned from the replica (or one without an epic ref) can't name its
 * entity, so it degrades to the full host scope rather than staying stale. */
function invalidateIndicatorsForHostRow(
  queryClient: QueryClient,
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  sourceId: string,
): void {
  if (hostId === null) return;
  const byId = useHostNotificationsStore.getState().byId;
  const entity = Object.hasOwn(byId, sourceId)
    ? notificationEntityFromHostEntry(byId[sourceId])
    : null;
  if (entity === null) {
    invalidateNotificationIndicators(queryClient, hostId, client);
    return;
  }
  invalidateNotificationIndicatorsForEntities(
    queryClient,
    hostId,
    [entity],
    client,
  );
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
      // TUI agent-stopped rows use the persisted `epic` payload shape, but
      // their actionable entity is the terminal agent itself. The canvas
      // addresses that record through the same chat-shaped route used for
      // `terminal-agent` tiles, so retain `tuiAgentId` instead of degrading
      // the click to the owning epic.
      return {
        kind: "chat",
        epicId: known.epicId,
        chatId: known.tuiAgentId,
      };
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
    // No focus hint: the deleted worktree's row is gone, and the list's saved
    // filters are the authoritative view to return to. A row from a NEWER host
    // whose operation payload this build cannot parse never reaches here at
    // all - it renders with common-field copy and no deep link, which is the
    // designed degradation rather than a guessed destination.
    case "worktree_deletion":
      return {
        kind: "hostSurface",
        surface: "worktreeSettings",
        focus: undefined,
      };
  }
}

const HOST_PAGE_LIMIT = 50;
