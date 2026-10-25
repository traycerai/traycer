import type { UseQueryResult } from "@tanstack/react-query";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * A team environment's onboarding (`bot.onboarding.read`, Tracy Bots T48):
 * its GitHub set, the areas offered as bots and the team's choice. Answered
 * from authn and the cloud, so any host gives the same answer; `client`
 * names the one that carries the request and `enabled` is the capability
 * gate the caller resolved. Read again on focus: an admin connects GitHub
 * on the dashboard, outside the app.
 */
export function useBotOnboardingQuery(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string,
  enabled: boolean,
): UseQueryResult<BotOnboardingReadResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "bot.onboarding.read">({
    cacheKeyIdentity: undefined,
    client,
    method: "bot.onboarding.read",
    params: { environmentId },
    options: { enabled, refetchOnWindowFocus: true },
  });
}
