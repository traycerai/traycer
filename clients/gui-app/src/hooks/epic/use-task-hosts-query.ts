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
      // A refusal is just as terminal for a consumer that mounts again on
      // it: one that unmounts on the error and remounts would otherwise ask
      // the host on every mount, a refusal and an authn check each time. A
      // verdict that returns clears it (`subscribeTaskHostRefusalReset`).
      retryOnMount: false,
    },
  });
}

/**
 * Resets every failed task-host read, mounted or not, each time a session is
 * promoted to a cloud verdict. A failure is kept across mounts (`retryOnMount:
 * false` above), so one cached while the verdict was withdrawn would
 * otherwise outlive the verdict's return and leave the task's hosts empty
 * until the cache dropped it. A mounted read fetches again; an unmounted one
 * fetches on its next mount.
 */
export function subscribeTaskHostRefusalReset(args: {
  readonly requestContextProvider: Pick<
    RequestContextProvider,
    "onSessionVerified"
  >;
  readonly queryClient: QueryClient;
}): RequestContextSubscription {
  return args.requestContextProvider.onSessionVerified(() => {
    void args.queryClient.resetQueries({
      predicate: (query) =>
        query.state.status === "error" &&
        hostQueryKeys.matchesMethodOnAnyHost(
          query.queryKey,
          "epic.listTaskHosts",
        ),
    });
  });
}
