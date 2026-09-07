import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

/** providerId selects the provider-pull branch of host.getRateLimitUsage; never coerce null (collides with the aperture key). */
export function useHostProviderRateLimitsQuery(
  providerId: RateLimitProviderId,
  profileId: string | null,
  fetchEligible: boolean,
) {
  const client = useHostClient();
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    ...providerRateLimitQueryOptions(providerId, profileId, fetchEligible),
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
}
