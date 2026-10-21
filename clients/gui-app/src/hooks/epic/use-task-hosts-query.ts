import { useEffect, useMemo } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
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
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const TASK_HOSTS_METHOD = "epic.listTaskHosts";
const refusalResetInstalled = new WeakSet<QueryClient>();

/**
 * Clears every failed task-host read, mounted or not, when cloud
 * authorization returns. A failure is kept across mounts (`retryOnMount:
 * false`), so one cached under a withdrawn verdict would otherwise outlive
 * the verdict's return and leave the task's hosts empty until the cache
 * drops it. A mounted read refetches; an unmounted one fetches on its next
 * mount.
 *
 * Installed once per client, from the first mount: a failure can only be
 * cached by a read that mounted.
 */
function installRefusalResetOnCloudRestore(queryClient: QueryClient): void {
  if (refusalResetInstalled.has(queryClient)) return;
  refusalResetInstalled.add(queryClient);
  useAuthStore.subscribe((state, previous) => {
    if (
      authorizesCloudCapability(previous.status) ||
      !authorizesCloudCapability(state.status)
    ) {
      return;
    }
    void queryClient.resetQueries({
      predicate: (query) =>
        query.state.status === "error" &&
        hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, TASK_HOSTS_METHOD),
    });
  });
}

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
  const queryClient = useQueryClient();
  useEffect(() => {
    installRefusalResetOnCloudRestore(queryClient);
  }, [queryClient]);
  return useHostQuery<HostRpcRegistry, typeof TASK_HOSTS_METHOD>({
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client,
    method: TASK_HOSTS_METHOD,
    params,
    preflight: cloudVerdictPreflight(TASK_HOSTS_METHOD),
    options: {
      enabled: cloudAuthorized && taskId.length > 0 && viewerUserId.length > 0,
      staleTime: 30_000,
      // An older host's E_HOST_UNSUPPORTED and every refusal are terminal;
      // only a transport failure heals without the person.
      retry: (_failureCount, error) => isTransientHostRpcFailure(error),
      // A refusal is just as terminal for a consumer that mounts again on
      // it: one that unmounts on the error and remounts would otherwise ask
      // the host on every mount, a refusal and an authn check each time.
      // Only cloud authorization returning clears it (see
      // `installRefusalResetOnCloudRestore`).
      retryOnMount: false,
    },
  });
}
