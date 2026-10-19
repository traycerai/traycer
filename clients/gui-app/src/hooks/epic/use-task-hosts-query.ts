import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
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
