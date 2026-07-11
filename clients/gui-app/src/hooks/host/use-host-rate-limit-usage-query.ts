import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { AccountContext } from "@traycer/protocol/common/schemas";

/**
 * Live artifact rate-limit usage for the default host. Default-host scoped, like
 * runtime capabilities. The value moves every Traycer turn, so there is no
 * `staleTime` - `useRefreshRateLimitUsageOnTraycerTurn` invalidates it on turn
 * completion. The caller supplies the account context so the Traycer popover
 * can render Personal and Team cards concurrently. Mounted only inside
 * `RateLimitView`, which is the implicit tier-gate (rate-limit tiers only).
 */
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
