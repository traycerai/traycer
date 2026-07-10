import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

/**
 * Provider-account rate limits (Codex / Claude Code CLI) for the default
 * host, read via the same `host.getRateLimitUsage` RPC the aperture query
 * (`useHostRateLimitUsageQuery`) uses - `providerId` in `params` selects the
 * `@1.2`+ provider-pull branch instead of the `accountContext` aperture
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
 * Uses `useHostQueryWithResponseMap` (not the plain `useHostQuery` every other
 * host RPC hook in this app uses) rather than the raw wire response, so the
 * cached `data` is the `ProviderRateLimitEnvelope` this ticket's retention
 * treatment needs: a transient failure (`usage_fetch_failed` and friends)
 * must retain the last good reading instead of the raw response overwriting
 * it outright. `provider-rate-limit-query-options.ts`'s `httpFetch` branch is
 * the ONLY lane that actually issues its own fetch through this hook
 * (`ephemeralProcess` providers stay a disabled, passive observer of whatever
 * `ephemeral-fetch-queue.ts` writes) - both routes fold their response through
 * the exact same `mapResponseToProviderRateLimitEnvelope` wrapper, so the two
 * write lanes can never disagree on the cached shape.
 *
 * Default-host scoped, for the Settings > Providers card
 * (`ProviderRateLimitSettingsCard`) and the header popover's per-provider
 * block (`RateLimitProviderBlock`).
 */
export function useHostProviderRateLimitsQuery(
  providerId: RateLimitProviderId,
  profileId: string | null,
) {
  const client = useHostClient();
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    ...providerRateLimitQueryOptions(providerId, profileId),
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
}
