import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BrowserReplicasListResponse } from "@traycer/protocol/host/browser/replicas";
import type { HostRpcRegistry } from "@/lib/host";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

export const BROWSER_REPLICAS_LIST_METHOD = "browser.replicas.list";

/**
 * The person's browser sessions in this task on their other machines, as
 * `hostId` holds them. The Browsers panel asks the canvas host: it holds the
 * task open, so its copies are kept current.
 *
 * Polled at the cadence the policy table gives the method; nothing else says
 * when a copy changed. A host that predates the method has nothing to list,
 * so the query stays off rather than asking it.
 */
export function useBrowserReplicasQuery(args: {
  readonly epicId: string;
  readonly hostId: string | null;
}): UseQueryResult<BrowserReplicasListResponse, HostRpcError> {
  const client = useHostClientForHostId(args.hostId);
  const supported = useHostSupportsMethod(
    args.hostId,
    BROWSER_REPLICAS_LIST_METHOD,
  );
  // Viewer-scoped: the answer is one person's sessions, so two people on one
  // installation must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery<HostRpcRegistry, "browser.replicas.list">({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: BROWSER_REPLICAS_LIST_METHOD,
    params: { epicId: args.epicId },
    options: {
      enabled: supported && args.epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      poll: true,
    },
  });
}
