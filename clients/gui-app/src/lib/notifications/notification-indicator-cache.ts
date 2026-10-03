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
  queueIndicatorInvalidation(queryClient, hostId, null, canceller);
}

export function invalidateNotificationIndicatorsForEntities(
  queryClient: QueryClient,
  hostId: string,
  entities: ReadonlyArray<HostNotificationsEntityRef>,
  canceller: NotificationIndicatorReadCanceller | null,
): void {
  if (entities.length === 0) return;
  queueIndicatorInvalidation(queryClient, hostId, entities, canceller);
}

interface PendingInvalidation {
  all: boolean;
  entities: HostNotificationsEntityRef[];
  canceller: NotificationIndicatorReadCanceller | null;
}

const pendingInvalidations = new WeakMap<
  QueryClient,
  Map<string, PendingInvalidation>
>();

function queueIndicatorInvalidation(
  queryClient: QueryClient,
  hostId: string,
  entities: ReadonlyArray<HostNotificationsEntityRef> | null,
  canceller: NotificationIndicatorReadCanceller | null,
): void {
  let hosts = pendingInvalidations.get(queryClient);
  if (hosts === undefined) {
    hosts = new Map();
    pendingInvalidations.set(queryClient, hosts);
  }
  const pending = hosts.get(hostId);
  if (pending !== undefined) {
    pending.all ||= entities === null;
    pending.entities.push(...(entities ?? []));
    pending.canceller = canceller;
    return;
  }
  const entry: PendingInvalidation = {
    all: entities === null,
    entities: [...(entities ?? [])],
    canceller,
  };
  hosts.set(hostId, entry);
  const owner = hosts;
  queueMicrotask(() => {
    void (async () => {
      do {
        if (pendingInvalidations.get(queryClient) !== owner) return;
        const all = entry.all;
        const changed = entry.entities;
        entry.all = false;
        entry.entities = [];
        await invalidateMatchingNotificationIndicators(
          queryClient,
          {
            queryKey: notificationsQueryKeys.indicatorScope(hostId),
            predicate: (query) =>
              all ||
              changed.some((entity) =>
                notificationsQueryKeys.isIndicatorQueryForEntity(
                  query.queryKey,
                  entity,
                ),
              ),
          },
          entry.canceller,
        );
        // Changes arriving during a read need a fresh successor, not a join to its stale answer.
      } while (owner.get(hostId)?.all || entry.entities.length > 0);
    })().finally(() => {
      if (owner.get(hostId) === entry) owner.delete(hostId);
    });
  });
}

async function invalidateMatchingNotificationIndicators(
  queryClient: QueryClient,
  filters: QueryFilters,
  canceller: NotificationIndicatorReadCanceller | null,
): Promise<void> {
  const fetchingQueries = queryClient
    .getQueryCache()
    .findAll(filters)
    .filter((query) => query.state.fetchStatus === "fetching");
  if (fetchingQueries.length === 0) {
    await queryClient.invalidateQueries(filters);
    return;
  }
  await queryClient
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
  pendingInvalidations.delete(queryClient);
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
