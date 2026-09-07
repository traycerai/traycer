import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  getRateLimitQueueTargetPhase,
  isRateLimitQueueTargetForced,
  isRateLimitReadFollowUpExhausted,
  subscribeRateLimitQueueTargets,
  type RateLimitQueueTargetPhase,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";

/** Observable queued/fetching state for one exact host/provider/profile target. */
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

/** Whether this exact target is queued AND already forced by a user action. */
export function useIsRateLimitQueueTargetForced(
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const queueScope = useRateLimitQueueScope();
  const getSnapshot = useCallback(() => {
    if (queueScope === null) return false;
    return isRateLimitQueueTargetForced(
      queueScope.hostId,
      providerId,
      profileId,
    );
  }, [profileId, providerId, queueScope]);

  return useSyncExternalStore(
    subscribeRateLimitQueueTargets,
    getSnapshot,
    () => false,
  );
}

/**
 * True when this target's delayed follow-up is spent. Suppressing a still-running read is only honest while something is still coming back.
 */
export function useIsRateLimitReadFollowUpExhausted(
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const queueScope = useRateLimitQueueScope();
  const getSnapshot = useCallback(() => {
    if (queueScope === null) return false;
    return isRateLimitReadFollowUpExhausted(
      queueScope.hostId,
      providerId,
      profileId,
    );
  }, [profileId, providerId, queueScope]);

  return useSyncExternalStore(
    subscribeRateLimitQueueTargets,
    getSnapshot,
    () => false,
  );
}

/** One target a control refreshes; the shape both fold callers already hold. */
export interface RateLimitQueueTargetRef {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
}

/** JSON rather than a delimiter join: a profile id is a free-form string off the provider, so no separator is provably absent from it, and `null` (follow the default profile) must stay distinct from `""`. */
function rateLimitTargetsKey(
  targets: ReadonlyArray<RateLimitQueueTargetRef>,
): string {
  return JSON.stringify(
    targets.map((target) => [target.providerId, target.profileId]),
  );
}

/** Inverse of {@link rateLimitTargetsKey}; round-trips any id byte-for-byte. */
function parseRateLimitTargetsKey(
  key: string,
): ReadonlyArray<RateLimitQueueTargetRef> {
  const decoded = JSON.parse(key) as ReadonlyArray<
    readonly [RateLimitProviderId, string | null]
  >;
  return decoded.map(([providerId, profileId]) => ({ providerId, profileId }));
}

/** Gate refresh on fetching, not lane-wide draining. queued does not count: that click is what promotes pending.force. */
export function useAnyRateLimitQueueTargetFetching(
  targets: ReadonlyArray<RateLimitQueueTargetRef>,
): boolean {
  const queueScope = useRateLimitQueueScope();
  const hostId = queueScope === null ? null : queueScope.hostId;
  // Keyed on the target identities rather than the array reference: callers
  // rebuild these lists every render, and a reference dep would resubscribe on
  // each one.
  const targetsKey = rateLimitTargetsKey(targets);
  const stableTargets = useMemo<ReadonlyArray<RateLimitQueueTargetRef>>(
    () => parseRateLimitTargetsKey(targetsKey),
    [targetsKey],
  );

  const getSnapshot = useCallback(() => {
    if (hostId === null) return false;
    return stableTargets.some(
      (target) =>
        getRateLimitQueueTargetPhase(
          hostId,
          target.providerId,
          target.profileId,
        ) === "fetching",
    );
  }, [hostId, stableTargets]);

  return useSyncExternalStore(
    subscribeRateLimitQueueTargets,
    getSnapshot,
    () => false,
  );
}
