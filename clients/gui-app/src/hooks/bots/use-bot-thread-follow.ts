import { useMemo } from "react";
import {
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  BotThreadFollowReadResponse,
  BotThreadFollowSetRequest,
  BotThreadFollowSetResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { toastFromHostError } from "@/lib/host-error-toast";
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";

const READ_METHOD = "bot.threadFollow.read";

/**
 * The person's follow state on each of a bot's threads
 * (`bot.threadFollow.read`, decision 137). Kept in the cloud, so any host
 * answers the same and it is the same on every device; read again when the
 * window comes back, which is when another device's change can have landed.
 * The follows are the PERSON's, so the key carries the viewer and the read
 * waits until the viewer resolves, as the notification levels do.
 */
export function useBotThreadFollowsQuery(
  client: HostClient<HostRpcRegistry> | null,
  botId: string,
  enabled: boolean,
): UseQueryResult<BotThreadFollowReadResponse, HostRpcError> {
  const params = useMemo(() => ({ botId }), [botId]);
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery<HostRpcRegistry, typeof READ_METHOD>({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: READ_METHOD,
    params,
    options: {
      enabled: enabled && viewerUserId.length > 0,
      refetchOnWindowFocus: true,
    },
  });
}

/** Whether `queryKey` is a follow read of `botId`, on any host scope. */
function isFollowReadOf(queryKey: QueryKey, botId: string): boolean {
  return (
    hostQueryKeys.matchesMethodOnAnyHost(queryKey, READ_METHOD) &&
    queryKey.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "botId" in part &&
        part.botId === botId,
    )
  );
}

type FollowSnapshot = ReadonlyArray<
  readonly [QueryKey, BotThreadFollowReadResponse | undefined]
>;

/**
 * Follows or unfollows one thread. The control moves at once: every cached
 * read of the bot's follows takes the new state (reason `manual`, as the
 * cloud writes it) and goes back to what it held if the write is refused.
 * Either way the follows are read again, which settles it.
 */
export function useBotThreadFollowSetMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotThreadFollowSetResponse,
  HostRpcError,
  BotThreadFollowSetRequest,
  FollowSnapshot
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "bot.threadFollow.set",
    FollowSnapshot
  >({
    client,
    method: "bot.threadFollow.set",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.setThreadFollow(),
      onMutate: async (variables) => {
        const filter = {
          predicate: (query: { readonly queryKey: QueryKey }) =>
            isFollowReadOf(query.queryKey, variables.botId),
        };
        await queryClient.cancelQueries(filter);
        const previous =
          queryClient.getQueriesData<BotThreadFollowReadResponse>(filter);
        queryClient.setQueriesData<BotThreadFollowReadResponse>(
          filter,
          (cached) =>
            cached === undefined
              ? cached
              : {
                  follows: {
                    ...cached.follows,
                    [variables.threadId]: {
                      state: variables.state,
                      reason: "manual",
                    },
                  },
                },
        );
        return previous;
      },
      onError: (error, variables, previous) => {
        for (const [key, data] of previous ?? []) {
          queryClient.setQueryData(key, data);
        }
        toastFromHostError(
          error,
          variables.state === "following"
            ? "Couldn't follow the thread."
            : "Couldn't unfollow the thread.",
        );
      },
      onSettled: (_data, _error, variables) =>
        queryClient.invalidateQueries({
          predicate: (query) => isFollowReadOf(query.queryKey, variables.botId),
        }),
    },
  });
}

/** Whether the tab's host reads and writes the person's thread follows. */
export function useBotThreadFollowSupported(hostId: string): boolean {
  const read = useHostMethodSupport(hostId, "bot.threadFollow.read") === true;
  const set = useHostMethodSupport(hostId, "bot.threadFollow.set") === true;
  return read && set;
}

/**
 * The person's follows of a bot's threads, through the tab's host; `null` on
 * a host that cannot read and write them.
 */
export function useBotThreadFollows(
  botId: string,
  hostId: string,
): UseQueryResult<BotThreadFollowReadResponse, HostRpcError> | null {
  const supported = useBotThreadFollowSupported(hostId);
  const follows = useBotThreadFollowsQuery(
    useTabHostClient(),
    botId,
    supported,
  );
  return supported ? follows : null;
}
