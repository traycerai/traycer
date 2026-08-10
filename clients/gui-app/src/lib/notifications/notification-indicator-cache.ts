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
