import { useCallback, useSyncExternalStore } from "react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  getRateLimitQueueTargetPhase,
  subscribeRateLimitQueueTargets,
  type RateLimitQueueTargetPhase,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";

/**
 * Observable queued/fetching state for one exact host/provider/profile target.
 * Unlike the lane-wide draining flag, this can render truthful row-level copy.
 */
export function useRateLimitQueueTargetPhase(
  providerId: RateLimitProviderId,
  profileId: string | null,
): RateLimitQueueTargetPhase | null {
  const queueScope = useRateLimitQueueScope();
  const getSnapshot = useCallback(() => {
    if (queueScope === null) return null;
    return getRateLimitQueueTargetPhase(
      queueScope.hostId,
      providerId,
      profileId,
    );
  }, [profileId, providerId, queueScope]);

  return useSyncExternalStore(
    subscribeRateLimitQueueTargets,
    getSnapshot,
    () => null,
  );
}
