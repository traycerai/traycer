import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { AccountContext } from "@traycer/protocol/common/schemas";

/** The value moves every Traycer turn, so there is no `staleTime` - `useRefreshRateLimitUsageOnTraycerTurn` invalidates it on turn completion. */
export function useHostRateLimitUsageQuery(
  accountContext: AccountContext,
  profileId: string | null,
) {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "host.getRateLimitUsage">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.getRateLimitUsage",
    params: { accountContext, profileId },
    options: {
      retry: false,
    },
  });
}
