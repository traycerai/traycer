import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { NotificationHooksStatusResponse } from "@traycer/protocol/host/notifications/host-notifications";
import { hostQueryKeys } from "@/lib/query-keys";

/** An acknowledged notification must disappear from its pending Settings view
 * too. Cancel older reads before pruning; receipt-retirement failures must not
 * recreate an unread alert. */
export async function consumePendingHookRemovalNotices(
  queryClient: QueryClient,
  hostId: string | null,
  selection:
    | { readonly ids: readonly string[] }
    | { readonly beforeUpdatedAt: number },
): Promise<void> {
  if (hostId === null) return;
  const queryKeys = [
    hostQueryKeys.methodScope(hostId, "host.notificationHooks.status"),
    hostQueryKeys.notificationHookRemovalBorrowedStatus(hostId),
  ];
  // Cloud markers can reach the origin later than their successful write.
  // Remember acknowledgments even before status arrives. This is session
  // history, so status-cache garbage collection must not reopen a receipt.
  if ("ids" in selection) {
    const readKey = hostQueryKeys.notificationHookRemovalReadIds(hostId);
    retainAcknowledgmentHistory(queryClient, readKey);
    queryClient.setQueryData<readonly string[]>(readKey, (ids) => [
      ...new Set([...(ids ?? []), ...selection.ids]),
    ]);
  } else {
    const cutoffKey = hostQueryKeys.notificationHookRemovalReadCutoff(hostId);
    retainAcknowledgmentHistory(queryClient, cutoffKey);
    queryClient.setQueryData<number>(cutoffKey, (cutoff) =>
      Math.max(cutoff ?? selection.beforeUpdatedAt, selection.beforeUpdatedAt),
    );
  }
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
  );
  for (const queryKey of queryKeys) {
    queryClient.setQueriesData<NotificationHooksStatusResponse>(
      { queryKey },
      (data) =>
        data === undefined
          ? undefined
          : filterConsumedHookRemovalNotices(data, queryClient, hostId),
    );
  }
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

/** Successful existing read/clear writes are monotonic for these receipt ids. */
export function filterConsumedHookRemovalNotices(
  response: NotificationHooksStatusResponse,
  queryClient: QueryClient,
  hostId: string | null,
): NotificationHooksStatusResponse {
  if (hostId === null) return response;
  const consumed = new Set(
    queryClient.getQueryData<readonly string[]>(
      hostQueryKeys.notificationHookRemovalReadIds(hostId),
    ) ?? [],
  );
  const cutoff = queryClient.getQueryData<number>(
    hostQueryKeys.notificationHookRemovalReadCutoff(hostId),
  );
  return {
    ...response,
    pendingRemovalNotices: response.pendingRemovalNotices.filter(
      (notice) =>
        !consumed.has(notice.id) &&
        (cutoff === undefined || notice.occurredAt > cutoff),
    ),
  };
}

/** These private history keys have no observers or query functions. Recreate
 * older entries to clear finite GC timers already scheduled before retention. */
function retainAcknowledgmentHistory(
  queryClient: QueryClient,
  queryKey: QueryKey,
): void {
  queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  const existing = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (existing === undefined || existing.gcTime === Infinity) return;
  const data = existing.state.data;
  queryClient.removeQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, data);
}
