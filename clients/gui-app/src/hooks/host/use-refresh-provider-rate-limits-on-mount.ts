import { useEffect } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * On mount (and whenever `providerId` changes to a new provider), ensures an
 * `ephemeralProcess` provider's rate limits get a fresh-data-on-open pull
 * through the shared serial queue (`force: false`, so it still no-ops if the
 * cached data is younger than `PROVIDER_RATE_LIMITS_STALE_TIME_MS`).
 *
 * This exists because `providerRateLimitQueryOptions` deliberately sets
 * `refetchOnMount: false` for this lane: TanStack's own default would
 * otherwise refetch straight through the query's `queryFn` on every mount,
 * bypassing the queue's single-subprocess-at-a-time guarantee. Routing the
 * mount trigger through `enqueueRateLimitFetch` instead means every
 * popover/Settings-card open (both of which mount this provider's query fresh)
 * gets the exact same guarantee every other automatic trigger (the interval
 * timer, a turn completion) already has: never a second subprocess racing one
 * already queued or in flight.
 *
 * `httpFetch` providers (openrouter, kilocode) don't need this: their query
 * keeps TanStack's default `refetchOnMount`, which is already safe there (a
 * plain GET, no subprocess to serialize) - this hook no-ops for them.
 */
export function useRefreshProviderRateLimitsOnMount(
  providerId: RateLimitProviderId,
): void {
  useEffect(() => {
    if (rateLimitFetchLane(providerId) !== "ephemeralProcess") return;
    void enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  }, [providerId]);
}
