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

/**
 * Cache-only observation: never `enabled`, so mounting this options object
 * against a query never initiates its own provider read - it only reflects
 * whatever the shared serial queue or another lane's active query already
 * wrote into that exact cache key. Exported for other picker-only surfaces
 * (`use-profile-usage-comparison.ts`) that need the same "observe, never
 * fetch" contract this module's own `useVisibleRateLimitProviders` uses.
 */
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
 * The currently-configured rate-limit-capable providers on the default host,
 * each tagged with its fetch lane. Drives both the interval timer (walks the
 * `ephemeralProcess` entries) and, later, the popover rail.
 *
 * Mounted persistently at the app-shell level (via `RateLimitQueueProvider`),
 * so `providers.list` is subscribed for the window's lifetime rather than
 * lazily on Settings open. `subscribed: true` keeps it refreshing so a
 * credential change (login/logout invalidates `providers.list`) re-gates the
 * set - a removed credential drops its provider here immediately, and the next
 * timer tick reads the shortened list.
 *
 * TanStack's structural sharing keeps `data.providers` referentially stable
 * across identical polls, so the memoized projection only recomputes on a real
 * list change.
 */
export function useConfiguredRateLimitProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  return useMemo(() => {
    if (providers === undefined) return [];
    return rateLimitProviderCandidates(providers).flatMap((provider) =>
      provider.fetchEligibility.ambient ? [provider] : [],
    );
  }, [providers]);
}

/**
 * Rate-limit providers that should be displayed in user-facing surfaces
 * (header glyph / popover). This deliberately has a wider gate than
 * `useConfiguredRateLimitProviders()`: the queue still polls only providers
 * whose account probe currently says a usage pull is safe, but display also
 * includes a provider once the shared provider-usage query cache has data or an
 * error for it. Candidate construction deliberately includes signed-out
 * providers: auth still makes `configured` false (so the polling hook above
 * drops them), while this display hook keeps observing their existing cache
 * entry. Ambient sign-out stops only the ambient queue; an authenticated
 * managed profile remains a valid target and keeps the provider visible even
 * before a cache entry exists. This display hook still observes existing
 * profile cache entries for every signed-out target.
 *
 * The cache observers below are passive (`enabled: false`) and only subscribe
 * to the existing `host.getRateLimitUsage` provider-pull keys. They do not
 * spawn extra CLI subprocesses or HTTP fetches.
 */
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
      candidates.flatMap((provider) =>
        provider.fetchEligibility.ambient ||
        provider.profiles.some((profile) =>
          isRateLimitProfileFetchEligible(provider.fetchEligibility, profile),
        ) ||
        cacheTargets.some(
          (target, targetIndex) =>
            target.providerId === provider.providerId &&
            hasProviderRateLimitCacheState(cacheQueries[targetIndex]),
        )
          ? [provider]
          : [],
      ),
    [cacheQueries, cacheTargets, candidates],
  );
}
