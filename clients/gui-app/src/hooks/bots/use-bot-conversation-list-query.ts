import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BotConversationListResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The conversation records under one bot (`bot.conversation.list`): the chat
 * rows a human reaches the bot through. Cloud-backed like `bot.list`, so the
 * tab's own host answers it whether or not it is the bound one.
 */
export function useBotConversationListQuery(
  client: HostClient<HostRpcRegistry> | null,
  botId: string,
  enabled: boolean,
): UseQueryResult<BotConversationListResponse, HostRpcError> {
  const params = useMemo(() => ({ botId }), [botId]);
  return useHostQuery<HostRpcRegistry, "bot.conversation.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "bot.conversation.list",
    params,
    options: { enabled, refetchOnWindowFocus: false },
  });
}
