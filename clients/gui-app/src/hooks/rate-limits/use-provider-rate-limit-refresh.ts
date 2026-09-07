import { useCallback } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import {
  useIsRateLimitQueueTargetForced,
  useRateLimitQueueTargetPhase,
} from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * ephemeralProcess refresh goes through the serial queue with force true; never query.refetch(). isRefreshing is this query's isFetching ORed with this target's queue phase.
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
  const targetPhase = useRateLimitQueueTargetPhase(providerId, profileId);
  const queueScope = useRateLimitQueueScope();
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
      await enqueueRateLimitFetchForScope(
        queueScope,
        providerId,
        DEFAULT_ACCOUNT_CONTEXT,
        {
          force: true,
          profileId,
        },
      );
      return;
    }
    await refetch();
  }, [fetchEligible, lane, profileId, providerId, queueScope, refetch]);

  // This provider's fetching (or queued+already-forced). queued+not-forced stays clickable so the click can promote pending.force.
  const targetForced = useIsRateLimitQueueTargetForced(providerId, profileId);
  const isRefreshing =
    fetchEligible &&
    (isFetching ||
      (lane === "ephemeralProcess" &&
        (targetPhase === "fetching" ||
          (targetPhase === "queued" && targetForced))));

  return { refresh, isRefreshing };
}
