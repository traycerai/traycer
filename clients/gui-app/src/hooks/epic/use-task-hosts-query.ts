import { useMemo } from "react";
import type { Query, QueryClient, UseQueryResult } from "@tanstack/react-query";
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
      // Permanent ends can arrive after the host leaves every live list.
      poll: true,
      // Retry transport failures; refusals wait for a scheduled refresh or
      // a renewed credential instead of entering a retry loop.
      retry: (_failureCount, error) => isTransientHostRpcFailure(error),
    },
  });
}

/**
 * Re-asks the task-host reads a returning cloud verdict can change, each time
 * a session is promoted to one. A refusal is terminal (`retry` above), so a
 * consumer that stays mounted on one would otherwise never ask again after
 * the verdict that was missing returns. A mounted read fetches again; an
 * unmounted one fetches on its next mount.
 *
 * Two kinds of read are re-asked: those that failed, and those still in
 * flight, which were dispatched before the verdict (the preflight gates
 * dispatch on it) and whose answer would land stale - a refusal settling
 * after this reset would stay terminal. The in-flight ones are cancelled
 * first, silently and without reverting, so no late answer lands.
 *
 * Only reads keyed to the viewer the verdict names are touched. The reads are
 * ACL-filtered per viewer, so refetching another viewer's entry would store
 * this viewer's answer under that viewer's key and serve it fresh when they
 * return; their entries wait for their own verdict.
 */
export function subscribeTaskHostRefusalReset(args: {
  readonly requestContextProvider: Pick<
    RequestContextProvider,
    "onSessionVerified"
  >;
  readonly queryClient: QueryClient;
}): RequestContextSubscription {
  return args.requestContextProvider.onSessionVerified((era) => {
    const viewer = era.identity;
    if (viewer === null) return;
    // Picked BEFORE the cancel and the reset: `resetQueries` re-applies its
    // filter to choose what to refetch, so a status filter would leave a read
    // reset and idle.
    const stale = new Set(
      args.queryClient.getQueryCache().findAll({
        predicate: (query) =>
          (query.state.status === "error" ||
            query.state.fetchStatus === "fetching") &&
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            "epic.listTaskHosts",
          ) &&
          // `useTaskHosts` keys the viewer as the last segment.
          query.queryKey.at(-1) === viewer,
      }),
    );
    if (stale.size === 0) return;
    const picked = { predicate: (query: Query) => stale.has(query) };
    // Cancel and reset in this one turn. The viewer is a fact about this
    // moment: awaiting the cancel would let a newer viewer's credential commit
    // before the refetch, which would then store that viewer's answer under
    // this viewer's key.
    void args.queryClient.cancelQueries(picked, {
      revert: false,
      silent: true,
    });
    void args.queryClient.resetQueries(picked);
  });
}
