import { useMemo } from "react";
import {
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  BotNotificationLevelReadResponse,
  BotNotificationLevelSetRequest,
  BotNotificationLevelSetResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";

/**
 * The person's notification level for each of a bot's conversations
 * (`bot.notificationLevel.read`, Tracy Bots T63). Kept in the cloud, so any
 * host answers the same and it is the same on every device; it is read
 * again when the window comes back, which is when another device's change
 * can have landed. The levels are the PERSON's, so the key carries the
 * viewer and the read waits until the viewer resolves (`useAutoPolicyQuery`
 * explains why): another account on the host never sees them.
 */
export function useBotNotificationLevelsQuery(
  client: HostClient<HostRpcRegistry> | null,
  botId: string,
  enabled: boolean,
): UseQueryResult<BotNotificationLevelReadResponse, HostRpcError> {
  const params = useMemo(() => ({ botId }), [botId]);
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery<HostRpcRegistry, "bot.notificationLevel.read">({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "bot.notificationLevel.read",
    params,
    options: {
      enabled: enabled && viewerUserId.length > 0,
      refetchOnWindowFocus: true,
    },
  });
}

/**
 * Sets the level of one conversation, then reads the levels again on every
 * host scope: the store is the cloud's, so a host's cached answer is stale
 * wherever it was read. The write stays pending until that read lands, so
 * the control is not released showing the old level. A refusal is shown
 * under the control, not toasted.
 */
export function useBotNotificationLevelSetMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotNotificationLevelSetResponse,
  HostRpcError,
  BotNotificationLevelSetRequest
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.notificationLevel.set">({
    client,
    method: "bot.notificationLevel.set",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.setNotificationLevel(),
      onSuccess: () =>
        queryClient.invalidateQueries({
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "bot.notificationLevel.read",
            ),
        }),
    },
  });
}
