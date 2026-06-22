import type { RateLimitUsageRequest } from "@traycer/protocol/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const RATE_LIMIT_USAGE_REQUEST: RateLimitUsageRequest = {};

/**
 * Live artifact rate-limit usage for the default host. Default-host scoped, like
 * runtime capabilities. The value moves every Traycer turn, so there is no
 * `staleTime` - `useRefreshRateLimitUsageOnTraycerTurn` invalidates it on turn
 * completion. Mounted only inside `RateLimitView`, which is the implicit
 * tier-gate (rate-limit tiers only).
 */
export function useHostRateLimitUsageQuery() {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "host.getRateLimitUsage">({
    client,
    method: "host.getRateLimitUsage",
    params: RATE_LIMIT_USAGE_REQUEST,
    options: {
      retry: false,
    },
  });
}
