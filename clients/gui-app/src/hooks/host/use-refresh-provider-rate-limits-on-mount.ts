import { useEffect } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * On mount (and whenever `providerId` changes), fetches when no successful
 * detailed value is cached OR the host's persisted summary is at least one
 * freshness window old. A fresh summary plus a cached detailed value no-ops.
 * This matters for managed profiles: the app-shell interval cannot assume
 * every one is already represented in this renderer's query cache.
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
 * `httpFetch` providers refetch their existing observer directly. CLI-backed
 * `ephemeralProcess` providers route through the shared serial queue.
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
  const queueScope = useRateLimitQueueScope();
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
    void enqueueRateLimitFetchForScope(
      queueScope,
      providerId,
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: false,
        profileId,
      },
    );
  }, [
    fetchEligible,
    hasCachedValue,
    profileId,
    providerId,
    queueScope,
    refetch,
    usageUpdatedAt,
  ]);
}
