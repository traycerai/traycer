import { useMemo } from "react";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import {
  isRateLimitCapableProvider,
  isRateLimitProviderConfigured,
  rateLimitFetchLane,
  type RateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

export interface ConfiguredRateLimitProvider {
  readonly providerId: RateLimitProviderId;
  readonly lane: RateLimitFetchLane;
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
    return providers.flatMap((state) => {
      const providerId = state.providerId;
      if (!isRateLimitCapableProvider(providerId)) return [];
      if (!isRateLimitProviderConfigured(state)) return [];
      return [{ providerId, lane: rateLimitFetchLane(providerId) }];
    });
  }, [providers]);
}
