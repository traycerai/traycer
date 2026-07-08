import { useMemo } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import {
  providerRateLimitQueryOptions,
  type ProviderRateLimitTanstackOptions,
} from "@/hooks/host/provider-rate-limit-query-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  isRateLimitCapableProvider,
  isRateLimitProviderConfigured,
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
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
}

interface RateLimitProviderCandidate extends ConfiguredRateLimitProvider {
  readonly configured: boolean;
}

interface ProviderRateLimitCacheState {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

const PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS: ProviderRateLimitTanstackOptions = {
  enabled: false,
  retry: false,
  staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  refetchInterval: false,
  refetchIntervalInBackground: false,
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
): ReadonlyArray<RateLimitProviderCandidate> {
  return providers.flatMap((state) => {
    const providerId = state.providerId;
    if (!state.enabled) return [];
    if (!isRateLimitCapableProvider(providerId)) return [];
    if (state.auth.status === "unauthenticated") return [];
    return [
      {
        providerId,
        lane: rateLimitFetchLane(providerId),
        configured: isRateLimitProviderConfigured(state),
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
      provider.configured
        ? [{ providerId: provider.providerId, lane: provider.lane }]
        : [],
    );
  }, [providers]);
}

/**
 * Rate-limit providers that should be displayed in user-facing surfaces
 * (header glyph / popover). This deliberately has a wider gate than
 * `useConfiguredRateLimitProviders()`: the queue still polls only providers
 * whose account probe currently says a usage pull is safe, but display also
 * includes a provider once the shared provider-usage query cache has data or an
 * error for it. Settings > Providers reads the same cache unconditionally for
 * the selected provider, so this keeps cached usage/error state visible in the
 * popover even when the CLI is signed in but the provider account-status probe
 * is temporarily `unavailable` ("Could not check account status").
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

  const cacheQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    requests: candidates.map((provider) => {
      const { method, params } = providerRateLimitQueryOptions(
        provider.providerId,
      );
      return { method, params };
    }),
    options: PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  return useMemo(
    () =>
      candidates.flatMap((provider, index) =>
        provider.configured ||
        hasProviderRateLimitCacheState(cacheQueries[index])
          ? [{ providerId: provider.providerId, lane: provider.lane }]
          : [],
      ),
    [cacheQueries, candidates],
  );
}
