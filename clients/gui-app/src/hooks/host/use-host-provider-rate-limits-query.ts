import { useHostQuery } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Provider-account rate limits (Codex / Claude Code CLI) for the default
 * host, read via the same `host.getRateLimitUsage` RPC the aperture query
 * (`useHostRateLimitUsageQuery`) uses - `providerId` in `params` selects the
 * `@1.2` provider-pull branch instead of the `accountContext` aperture
 * branch, so the two hooks produce distinct query keys without colliding.
 * `accountContext` is still sent because the request schema requires it
 * (default-valued in `@1.1`); the provider-pull resolver ignores it.
 *
 * Takes a non-null `RateLimitProviderId` rather than `ProviderId | null`:
 * every caller already gates on `isRateLimitCapableProvider` (or a prop
 * typed `RateLimitProviderId`) before mounting the component that calls this
 * hook, so a `null` branch here would be dead - and a `providerId ?? undefined`
 * coercion in `params` would hash to the exact same query key as the
 * aperture query's `{ accountContext }`, silently sharing its cache entry.
 *
 * Default-host scoped, for the Settings > Providers card
 * (`ProviderRateLimitSettingsCard`).
 */
export function useHostProviderRateLimitsQuery(
  providerId: RateLimitProviderId,
) {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "host.getRateLimitUsage">({
    client,
    ...providerRateLimitQueryOptions(providerId),
  });
}
