import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import type { HostNotificationsIndicatorStateRequest } from "@traycer/protocol/host/notifications/contracts";
import { notificationsQueryKeys } from "@/lib/query-keys";

export interface NotificationIndicatorReadCanceller {
  cancelActiveRead(
    method: "host.notifications.indicatorState",
    params: HostNotificationsIndicatorStateRequest,
  ): void;
}

export function invalidateNotificationIndicators(
  queryClient: QueryClient,
  hostId: string,
  canceller: NotificationIndicatorReadCanceller | null,
): void {
  invalidateMatchingNotificationIndicators(
    queryClient,
    {
      queryKey: notificationsQueryKeys.indicatorScope(hostId),
    },
    canceller,
  );
}

export function invalidateNotificationIndicatorsForEntities(
  queryClient: QueryClient,
  hostId: string,
  entities: ReadonlyArray<HostNotificationsEntityRef>,
  canceller: NotificationIndicatorReadCanceller | null,
): void {
  if (entities.length === 0) return;
  invalidateMatchingNotificationIndicators(
    queryClient,
    {
      queryKey: notificationsQueryKeys.indicatorScope(hostId),
      predicate: (query) =>
        entities.some((entity) =>
          notificationsQueryKeys.isIndicatorQueryForEntity(
            query.queryKey,
            entity,
          ),
        ),
    },
    canceller,
  );
}

function invalidateMatchingNotificationIndicators(
  queryClient: QueryClient,
  filters: QueryFilters,
  canceller: NotificationIndicatorReadCanceller | null,
): void {
  const fetchingQueries = queryClient
    .getQueryCache()
    .findAll(filters)
    .filter((query) => query.state.fetchStatus === "fetching");
  if (fetchingQueries.length === 0) {
    void queryClient.invalidateQueries(filters);
    return;
  }
  void queryClient
    .cancelQueries({
      predicate: (query) =>
        query.state.fetchStatus === "fetching" &&
        fetchingQueries.includes(query),
    })
    .then(() => {
      if (canceller !== null) {
        for (const query of fetchingQueries) {
          const params = indicatorRequestFromQueryKey(query.queryKey);
          if (params !== null) {
            canceller.cancelActiveRead(
              "host.notifications.indicatorState",
              params,
            );
          }
        }
      }
      return queryClient.invalidateQueries(filters);
    });
}

/**
 * Re-asks every host whose cached answer is its whole origin (`complete`).
 * Such an answer replaces the cloud's count for that origin, so it holds only
 * while it is current: once the cloud snapshot changes, a host the GUI keeps
 * no feed of (and so never invalidates on its own frames) would otherwise
 * mask the cloud rows that reached it since. A partition answer counts
 * nothing over the cloud, so it is left alone.
 *
 * A read still in flight is fenced whatever it held before: its answer may
 * be a whole origin computed before the snapshot, first read or not. The
 * queries are chosen once, here, because cancelling reverts a first read to
 * no data, and the re-ask must still include it.
 */
export function invalidateCompleteNotificationIndicators(
  queryClient: QueryClient,
): void {
  const selected = new Set(
    queryClient.getQueryCache().findAll({
      predicate: (query) =>
        notificationsQueryKeys.isIndicatorQuery(query.queryKey) &&
        (query.state.fetchStatus === "fetching" ||
          (isRecord(query.state.data) && query.state.data.complete === true)),
    }),
  );
  if (selected.size === 0) return;
  invalidateMatchingNotificationIndicators(
    queryClient,
    { predicate: (query) => selected.has(query) },
    null,
  );
}

/** How long the cloud feed stays quiet before a snapshot burst re-asks the
 * hosts (`createCompleteNotificationIndicatorsReask`). */
export const COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS = 300;

export interface CompleteNotificationIndicatorsReask {
  /** A cloud snapshot was accepted; re-ask once the feed goes quiet. */
  schedule(): void;
  dispose(): void;
}

/**
 * `invalidateCompleteNotificationIndicators` once per burst of cloud
 * snapshots, after the last of them. Re-asking on every snapshot cancels each
 * read the one before restarted, so under a burst a first read could never
 * settle. Whatever is still in flight, or holds a whole-origin answer, when
 * the burst ends is re-asked then, so no answer older than the last snapshot
 * survives it.
 */
export function createCompleteNotificationIndicatorsReask(
  queryClient: QueryClient,
  quietMs: number,
): CompleteNotificationIndicatorsReask {
  let cancelPending: (() => void) | null = null;
  return {
    schedule: () => {
      cancelPending?.();
      const handle = globalThis.setTimeout(() => {
        cancelPending = null;
        invalidateCompleteNotificationIndicators(queryClient);
      }, quietMs);
      cancelPending = () => globalThis.clearTimeout(handle);
    },
    dispose: () => {
      cancelPending?.();
      cancelPending = null;
    },
  };
}

export function clearNotificationIndicatorCaches(
  queryClient: QueryClient,
): void {
  queryClient.removeQueries({
    predicate: (query) =>
      notificationsQueryKeys.isIndicatorQuery(query.queryKey),
  });
}

function indicatorRequestFromQueryKey(
  queryKey: readonly unknown[],
): HostNotificationsIndicatorStateRequest | null {
  const request = queryKey[3];
  if (!isRecord(request)) return null;
  const epicIds = copyStringArray(request.epicIds);
  const chatIds = copyStringArray(request.chatIds);
  if (epicIds === null || chatIds === null) return null;
  return { epicIds, chatIds };
}

function copyStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
