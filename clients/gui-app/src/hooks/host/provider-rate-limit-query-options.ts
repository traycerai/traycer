import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { UseHostQueryOptions } from "@/hooks/host/use-host-query";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import type { HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * The method/params/options `useHostProviderRateLimitsQuery` builds its query
 * from - split out so a future host-scoped variant (e.g. tab-scoped) can
 * reuse the same shape without duplicating it.
 */
export function providerRateLimitQueryOptions(
  providerId: RateLimitProviderId,
): Omit<
  UseHostQueryOptions<HostRpcRegistry, "host.getRateLimitUsage">,
  "client"
> {
  return {
    method: "host.getRateLimitUsage",
    params: { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId },
    options: {
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    },
  };
}
