import { useMemo } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { hostQueryKeys } from "@/lib/query-keys";

type GetChatRunSettingsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.getChatRunSettings"
>;

/** `client` is originHostId, never the tab host. No polling; mutations invalidate. */
export function useChatRunSettings(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly enabled: boolean;
}): UseQueryResult<GetChatRunSettingsResponse, HostRpcError> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(
    () => ({ epicId: args.epicId, chatId: args.chatId }),
    [args.epicId, args.chatId],
  );
  return useHostQuery<HostRpcRegistry, "epic.getChatRunSettings">({
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: "epic.getChatRunSettings",
    params,
    options: {
      enabled: args.enabled && viewerUserId.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Note this cannot be left to the poll table: `epic.getChatRunSettings` is a `poll: null` method, so `useHostQuery` injects no `retry: false` of its own (only `kind: "condition"` methods get that), and the production default retry would otherwise apply.
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}

/** The caller must establish the ownership boundary before passing `chatIds`: one requester cannot resolve records owned by another host. */
export function useChatRunSettingsBatch(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}): Array<UseQueryResult<GetChatRunSettingsResponse, HostRpcError>> {
  const viewerUserId = useCloudChatViewerId();
  const requests = useMemo(
    () =>
      args.chatIds.map((chatId) => ({
        method: "epic.getChatRunSettings" as const,
        params: { epicId: args.epicId, chatId },
      })),
    [args.chatIds, args.epicId],
  );
  return useHostQueries<HostRpcRegistry, "epic.getChatRunSettings">({
    cacheKeyIdentity: viewerUserId,
    client: args.client,
    requests,
    options: {
      enabled: args.enabled && viewerUserId.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}

/** Method-scoped invalidation after a run-settings write. Observer presence does not refetch a fresh cache entry. */
export function invalidateChatRunSettings(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.getChatRunSettings"),
  });
}
