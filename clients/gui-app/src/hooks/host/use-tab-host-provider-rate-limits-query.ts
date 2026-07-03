import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { type HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Tab-scoped counterpart to `useHostProviderRateLimitsQuery`: identical
 * request shape (see its doc comment for why `providerId` is a non-null
 * `RateLimitProviderId`), bound to the CURRENT tab's host (`useTabHostClient`)
 * instead of the app-wide default host, mirroring the
 * `useProvidersList` / `useTabProvidersList` split (CLAUDE.md host-identity
 * model - a chat tab's turns run on its own bound host, which can differ
 * from the renderer-default one).
 *
 * Used by the context-usage popover and pinned strip, both rendered inside
 * a chat tile (`<TabHostProvider>`).
 */
export function useTabHostProviderRateLimitsQuery(
  providerId: RateLimitProviderId,
) {
  const client = useTabHostClient();
  return useHostQuery<HostRpcRegistry, "host.getRateLimitUsage">({
    client,
    method: "host.getRateLimitUsage",
    params: { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId },
    options: {
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    },
  });
}
