import { useMemo } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type {
  RequestContextProvider,
  RequestContextSubscription,
} from "@traycer-clients/shared/auth/request-context-provider";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  isTransientHostRpcFailure,
  type HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { cloudChatListCacheKeyIdentity } from "@/lib/chats/cloud-chat-list-cache";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * `epic.listTaskHosts`: the task's hosts with their
 * owner principal and reach, through the epic session's host, as the cloud
 * chat list is read. ACL-filtered per viewer, so the key carries the viewer;
 * the reach is the server's, from the credential the serving host sends.
 */
export function useTaskHosts(
  client: HostClient<HostRpcRegistry> | null,
  taskId: string,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listTaskHosts">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const params = useMemo(() => ({ taskId }), [taskId]);
  return useHostQuery<HostRpcRegistry, "epic.listTaskHosts">({
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client,
    method: "epic.listTaskHosts",
    params,
    preflight: cloudVerdictPreflight("epic.listTaskHosts"),
    options: {
      enabled: cloudAuthorized && taskId.length > 0 && viewerUserId.length > 0,
      staleTime: 30_000,
      // An older host's E_HOST_UNSUPPORTED and every refusal are terminal;
      // only a transport failure heals without the person.
      retry: (_failureCount, error) => isTransientHostRpcFailure(error),
    },
  });
}

/**
 * Resets every failed task-host read, mounted or not, each time a session is
 * promoted to a cloud verdict. A refusal is terminal (`retry` above), so a
 * consumer that stays mounted on one would otherwise never ask again after
 * the verdict that was missing returns. A mounted read fetches again; an
 * unmounted one fetches on its next mount.
 */
export function subscribeTaskHostRefusalReset(args: {
  readonly requestContextProvider: Pick<
    RequestContextProvider,
    "onSessionVerified"
  >;
  readonly queryClient: QueryClient;
}): RequestContextSubscription {
  return args.requestContextProvider.onSessionVerified(() => {
    // The failed reads are picked BEFORE the reset: `resetQueries` re-applies
    // its filter to choose what to refetch, and a reset read is no longer in
    // `error`, so a status filter would leave a mounted read reset and idle.
    const failed = new Set(
      args.queryClient.getQueryCache().findAll({
        predicate: (query) =>
          query.state.status === "error" &&
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            "epic.listTaskHosts",
          ),
      }),
    );
    if (failed.size === 0) return;
    void args.queryClient.resetQueries({
      predicate: (query) => failed.has(query),
    });
  });
}
