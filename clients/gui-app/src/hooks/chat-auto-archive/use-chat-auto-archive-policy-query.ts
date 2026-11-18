import type { UseQueryResult } from "@tanstack/react-query";
import type { ChatAutoArchiveGetResponse } from "@traycer/protocol/host/chat-auto-archive/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders. `hostQueryKeys.chatAutoArchiveForViewer` restates
// this `{}` - keep the two in step.
const CHAT_AUTO_ARCHIVE_GET_PARAMS = {};

/**
 * The account's chat auto-archive policy and the host's threshold bounds, as
 * the surface's host sees them.
 *
 * ACCOUNT data over a HOST call, as `useAutoPolicyQuery` is: the record lives
 * on traycer-server so it follows the user to every host, and the host proxies
 * it so what Settings shows is what that host's sweep actually applies.
 *
 * Partitioned by viewer (`cacheKeyIdentity: [viewerUserId]`) and disabled
 * while the viewer is `""`, for the cross-identity reasons spelled out in
 * `useAutoPolicyQuery`: a host-shaped key says nothing about WHO asked, and
 * `""` is the absence of an identity, not one. `refetchOnMount: "always"`
 * because another device may have saved since this window last looked; no
 * polling and no focus refetch.
 *
 * An OPTIONAL capability; callers gate on `useHostMethodSupport` for both
 * `chatAutoArchive.get` and `chatAutoArchive.set`.
 */
export function useChatAutoArchivePolicyQuery(): UseQueryResult<
  ChatAutoArchiveGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "chatAutoArchive.get",
    params: CHAT_AUTO_ARCHIVE_GET_PARAMS,
    options: {
      enabled: viewerUserId.length > 0,
      refetchOnWindowFocus: false,
      refetchOnMount: "always",
    },
  });
}
