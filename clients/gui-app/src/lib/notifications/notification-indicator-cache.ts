import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { notificationsQueryKeys } from "@/lib/query-keys";

export function invalidateNotificationIndicators(
  queryClient: QueryClient,
  hostId: string,
): void {
  invalidateMatchingNotificationIndicators(queryClient, {
    queryKey: notificationsQueryKeys.indicatorScope(hostId),
  });
}

export function invalidateNotificationIndicatorsForEntities(
  queryClient: QueryClient,
  hostId: string,
  entities: ReadonlyArray<HostNotificationsEntityRef>,
): void {
  if (entities.length === 0) return;
  invalidateMatchingNotificationIndicators(queryClient, {
    queryKey: notificationsQueryKeys.indicatorScope(hostId),
    predicate: (query) =>
      entities.some((entity) =>
        notificationsQueryKeys.isIndicatorQueryForEntity(
          query.queryKey,
          entity,
        ),
      ),
  });
}

function invalidateMatchingNotificationIndicators(
  queryClient: QueryClient,
  filters: QueryFilters,
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
    .then(() => queryClient.invalidateQueries(filters));
}

export function clearNotificationIndicatorCaches(
  queryClient: QueryClient,
): void {
  queryClient.removeQueries({
    predicate: (query) =>
      notificationsQueryKeys.isIndicatorQuery(query.queryKey),
  });
}
