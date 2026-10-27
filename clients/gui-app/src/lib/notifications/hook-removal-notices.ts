import type { QueryClient } from "@tanstack/react-query";
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
  const selectedIds = new Set("ids" in selection ? selection.ids : []);
  const consumed = queryKeys
    .flatMap((queryKey) =>
      queryClient.getQueriesData<NotificationHooksStatusResponse>({ queryKey }),
    )
    .flatMap(([, data]) => data?.pendingRemovalNotices ?? [])
    .filter((notice) =>
      "ids" in selection
        ? selectedIds.has(notice.id)
        : notice.occurredAt <= selection.beforeUpdatedAt,
    )
    .map((notice) => notice.id);
  if (consumed.length === 0) return;
  // Cloud markers can reach the origin later than their successful write.
  // Keep that confirmed result across status reads; receipt ids never reopen.
  const readKey = hostQueryKeys.notificationHookRemovalReadIds(hostId);
  queryClient.setQueryData<readonly string[]>(readKey, (ids) => [
    ...new Set([...(ids ?? []), ...consumed]),
  ]);
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
  return {
    ...response,
    pendingRemovalNotices: response.pendingRemovalNotices.filter(
      (notice) => !consumed.has(notice.id),
    ),
  };
}
