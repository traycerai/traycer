import { useCallback } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";
import {
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * The single source of truth for "how do I refresh one provider's rate limits,
 * and is that provider currently refreshing" - shared verbatim by the popover's
 * per-provider block and the Settings card so their refresh button can never
 * drift apart again.
 *
 * - **Action (`refresh`)**:
 *   - `ephemeralProcess` (codex, claude-code, grok): a forced
 *     `fetchProviderRateLimits`. A bare `query.refetch()` here would run the
 *     observer's `queryFn`, which carries no `force` at all; the fetch function
 *     is the one place that knows to wait out an automatic read already in
 *     flight so the click is not answered from the host's gauge.
 *   - `httpFetch` (openrouter, kilocode, ...): a plain GET with no subprocess,
 *     so it just refetches its own query.
 *
 * - **Spinner state (`isRefreshing`)**: `query.isFetching` on THIS provider's
 *   own query key, whoever triggered it - the fetch function, a direct
 *   refetch, an invalidation. Every read of this key runs through TanStack, so
 *   there is no other state to consult.
 *
 * `isFetching` / `refetch` are threaded in from the caller's existing
 * `useHostProviderRateLimitsQuery` observer rather than opening a second one
 * here, so there is still exactly one query observer per mounted block.
 */
export interface ProviderRateLimitRefreshInput {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly hasCachedValue: boolean;
  readonly fetchEligible: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

export function useProviderRateLimitRefresh({
  providerId,
  profileId,
  usageUpdatedAt,
  hasCachedValue,
  fetchEligible,
  isFetching,
  refetch,
}: ProviderRateLimitRefreshInput): {
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
} {
  const fetchScope = useProviderRateLimitFetchScope();
  const lane = rateLimitFetchLane(providerId);
  // Cold-start/recovery refresh for both lanes. Successful cached values leave
  // freshness to the interval timer and manual refresh action.
  useRefreshProviderRateLimitsOnMount({
    providerId,
    profileId,
    usageUpdatedAt,
    hasCachedValue,
    fetchEligible,
    refetch,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!fetchEligible) return;
    if (lane === "ephemeralProcess") {
      await fetchProviderRateLimits(
        fetchScope,
        { providerId, accountContext: DEFAULT_ACCOUNT_CONTEXT, profileId },
        { force: true },
      );
      return;
    }
    await refetch();
  }, [fetchEligible, fetchScope, lane, profileId, providerId, refetch]);

  return { refresh, isRefreshing: fetchEligible && isFetching };
}
