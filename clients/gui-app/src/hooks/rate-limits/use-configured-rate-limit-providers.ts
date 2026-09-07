import { useMemo } from "react";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import {
  providerRateLimitQueryOptions,
  type ProviderRateLimitTanstackOptions,
} from "@/hooks/host/provider-rate-limit-query-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  isRateLimitCapableProvider,
  isRateLimitProfileFetchEligible,
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  resolveRateLimitFetchEligibility,
  type RateLimitFetchEligibility,
  type RateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

export interface ConfiguredRateLimitProvider {
  readonly providerId: RateLimitProviderId;
  readonly lane: RateLimitFetchLane;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  /** Target-scoped credential eligibility, independent from display/cache state. */
  readonly fetchEligibility: RateLimitFetchEligibility;
}

interface ProviderRateLimitCacheState {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

/** Cache-only observation: never `enabled`, so mounting this options object against a query never initiates its own provider read - it only reflects whatever the shared serial queue or another lane's active query already wrote into that exact cache key. */
export const PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS: ProviderRateLimitTanstackOptions =
  {
    enabled: false,
    gcTime: Infinity,
    poll: false,
    retry: false,
    staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    refetchOnMount: false,
  };

function hasProviderRateLimitCacheState(
  query: ProviderRateLimitCacheState | undefined,
): boolean {
  if (query === undefined) return false;
  if (query.isError) return true;
  const envelope = query.data;
  if (envelope === undefined) return false;
  return envelope.latest !== null || envelope.lastGood !== null;
}

/** True when at least one ambient or managed target can safely pull usage. */
function hasEligibleFetchTarget(
  provider: ConfiguredRateLimitProvider,
): boolean {
  return (
    provider.fetchEligibility.ambient ||
    provider.profiles.some((profile) =>
      isRateLimitProfileFetchEligible(provider.fetchEligibility, profile),
    )
  );
}

function rateLimitProviderCandidates(
  providers: readonly ProviderCliState[],
): ReadonlyArray<ConfiguredRateLimitProvider> {
  return providers.flatMap((state) => {
    const providerId = state.providerId;
    if (!state.enabled) return [];
    if (!isRateLimitCapableProvider(providerId)) return [];
    return [
      {
        providerId,
        lane: rateLimitFetchLane(providerId),
        profiles: state.profiles,
        fetchEligibility: resolveRateLimitFetchEligibility(state),
      },
    ];
  });
}

/**
 * App-shell mount keeps `providers.list` subscribed for the window lifetime so a credential change re-gates the set immediately.
 */
export function useConfiguredRateLimitProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  return useMemo(() => {
    if (providers === undefined) return [];
    return rateLimitProviderCandidates(providers).flatMap((provider) =>
      hasEligibleFetchTarget(provider) ? [provider] : [],
    );
  }, [providers]);
}

/** Wider than the poll gate: keep observing cached signed-out entries. Observers are enabled false. */
export function useVisibleRateLimitProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
  const client = useHostClient();
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  const candidates = useMemo(
    () =>
      providers === undefined ? [] : rateLimitProviderCandidates(providers),
    [providers],
  );
  const cacheTargets = useMemo(
    () =>
      candidates.flatMap((provider) => {
        if (provider.profiles.length === 0) {
          return [{ providerId: provider.providerId, profileId: null }];
        }
        return provider.profiles.map((profile) => ({
          providerId: provider.providerId,
          profileId: profile.kind === "ambient" ? null : profile.profileId,
        }));
      }),
    [candidates],
  );

  const cacheQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: cacheTargets.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        target.providerId,
        target.profileId,
        false,
      );
      return { method, params };
    }),
    options: PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  return useMemo(
    () =>
      candidates.flatMap((provider) => {
        const hideOpenCode =
          provider.providerId === "opencode" &&
          cacheTargets.some((target, targetIndex) => {
            if (target.providerId !== "opencode") return false;
            const latest = cacheQueries[targetIndex]?.data?.latest;
            return (
              latest?.provider === "opencode" &&
              !latest.available &&
              latest.reason === "rate_limits_not_available"
            );
          });
        if (hideOpenCode) return [];
        return hasEligibleFetchTarget(provider) ||
          cacheTargets.some(
            (target, targetIndex) =>
              target.providerId === provider.providerId &&
              hasProviderRateLimitCacheState(cacheQueries[targetIndex]),
          )
          ? [provider]
          : [];
      }),
    [cacheQueries, cacheTargets, candidates],
  );
}
