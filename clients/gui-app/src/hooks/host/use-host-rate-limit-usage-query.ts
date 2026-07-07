import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useAccountContextStore } from "@/stores/auth/account-context-store";

/**
 * Live artifact rate-limit usage for the default host. Default-host scoped, like
 * runtime capabilities. The value moves every Traycer turn, so there is no
 * `staleTime` - `useRefreshRateLimitUsageOnTraycerTurn` invalidates it on turn
 * completion. Mounted only inside `RateLimitView`, which is the implicit
 * tier-gate (rate-limit tiers only).
 */
export function useHostRateLimitUsageQuery() {
  const client = useHostClient();
  const accountContext = useAccountContextStore((s) => s.accountContext);
  return useHostQuery<HostRpcRegistry, "host.getRateLimitUsage">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.getRateLimitUsage",
    params: { accountContext },
    options: {
      retry: false,
    },
  });
}
