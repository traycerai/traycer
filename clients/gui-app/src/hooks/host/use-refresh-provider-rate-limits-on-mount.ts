import { useEffect } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";

/**
 * On mount (and whenever `providerId` changes), fetches when no successful
 * detailed value is cached OR the host's persisted summary is at least one
 * freshness window old. A fresh summary plus a cached detailed value no-ops.
 * This matters for managed profiles: the app-shell interval cannot assume
 * every one is already represented in this renderer's query cache.
 *
 * This exists because `providerRateLimitQueryOptions` deliberately sets
 * `refetchOnMount: false` for the `ephemeralProcess` lane: TanStack's own
 * mount refetch would run the observer's `queryFn`, which sends no `force`,
 * and an absent `force` reads on the wire as forced - a real CLI probe on
 * every popover or Settings-card open. Routing the mount trigger through
 * `fetchProviderRateLimits` with `force: false` instead lets the host answer
 * from its gauge whenever its floors allow.
 *
 * `httpFetch` providers refetch their existing observer directly.
 */
export interface ProviderRateLimitsMountRefreshInput {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly hasCachedValue: boolean;
  readonly fetchEligible: boolean;
  readonly refetch: (() => Promise<unknown>) | null;
}

export function useRefreshProviderRateLimitsOnMount({
  providerId,
  profileId,
  usageUpdatedAt,
  hasCachedValue,
  fetchEligible,
  refetch,
}: ProviderRateLimitsMountRefreshInput): void {
  const fetchScope = useProviderRateLimitFetchScope();
  useEffect(() => {
    if (!fetchEligible) return;
    const summaryFresh =
      usageUpdatedAt !== null &&
      Date.now() - usageUpdatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS;
    if (summaryFresh && hasCachedValue) return;
    if (rateLimitFetchLane(providerId) === "httpFetch") {
      if (refetch === null) return;
      void refetch();
      return;
    }
    void fetchProviderRateLimits(
      fetchScope,
      { providerId, accountContext: DEFAULT_ACCOUNT_CONTEXT, profileId },
      { force: false },
    );
  }, [
    fetchEligible,
    fetchScope,
    hasCachedValue,
    profileId,
    providerId,
    refetch,
    usageUpdatedAt,
  ]);
}
