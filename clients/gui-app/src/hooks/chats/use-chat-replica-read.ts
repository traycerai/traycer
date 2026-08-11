import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * The doc-replica fallback read for one chat (`PublishedChatTile`'s call when
 * the cloud read has already settled `unpublished`).
 *
 * An unsupported or older host answers `E_HOST_UNSUPPORTED`, same as every
 * other optional local-read here - the caller reads that as "no replica"
 * (`query.data === undefined`), same shape as `unavailable`, never an error
 * toast: a missing capability is exactly the case this fallback exists to
 * soften, not a transport failure to report.
 *
 * VIEWER-scoped like every cloud-chat read (see `use-cloud-chat-queries.ts`'s
 * privacy note), and load-bearing here for the same reason plus one: with
 * `staleTime: Infinity`, an unscoped key would hand a signed-in account the
 * PREVIOUS account's cached replica transcript forever, not merely for a GC
 * window - the renderer's auth transition invalidates host queries but does
 * not evict their data. The signed-in viewer rides the cache key, and no
 * viewer resolved means no request rather than an unattributed one.
 */

export interface UseChatReplicaReadArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly enabled: boolean;
}

export function useChatReplicaRead(
  args: UseChatReplicaReadArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.chatReplicaRead">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(
    () => ({ epicId: args.epicId, chatId: args.chatId }),
    [args.epicId, args.chatId],
  );
  return useHostQuery<HostRpcRegistry, "epic.chatReplicaRead">({
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: "epic.chatReplicaRead",
    params,
    options: {
      enabled:
        args.enabled &&
        viewerUserId.length > 0 &&
        args.epicId.length > 0 &&
        args.chatId.length > 0,
      // One-shot: the doc content of an unreachable owner's chat cannot
      // change while its owner is away (matches the policy table's
      // `poll: null` for this method).
      staleTime: Infinity,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}
