import type { UseQueryResult } from "@tanstack/react-query";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const EMPTY_PARAMS = {};

/**
 * Every live bot across every environment the caller belongs to (`bot.list`),
 * each row carrying its `environmentId` so Home can group them. Cloud-backed,
 * so any host answers the same list; `client` names the one that carries the
 * request and `enabled` is the capability gate the caller resolved.
 */
export function useBotListQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<BotListResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "bot.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "bot.list",
    params: EMPTY_PARAMS,
    options: { enabled, refetchOnWindowFocus: true },
  });
}
