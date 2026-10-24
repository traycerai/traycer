import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BotThreadListResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The threads of a bot's channel (`bot.thread.list`): each post's thread
 * with its reply count, last reply, open requests and cost. Only the bot's
 * bound host answers, so it is read only by a tab bound there. It is read
 * again when the bot's subscription says its conversations moved
 * (`use-bot-subscription.ts`), never on a timer.
 */
export function useBotThreadListQuery(
  client: HostClient<HostRpcRegistry> | null,
  botId: string,
  args: { readonly enabled: boolean },
): UseQueryResult<BotThreadListResponse, HostRpcError> {
  const params = useMemo(() => ({ botId }), [botId]);
  return useHostQuery<HostRpcRegistry, "bot.thread.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "bot.thread.list",
    params,
    options: {
      enabled: args.enabled,
      refetchOnWindowFocus: false,
    },
  });
}
