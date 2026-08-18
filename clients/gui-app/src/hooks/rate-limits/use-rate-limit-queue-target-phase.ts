import { useCallback, useMemo, useSyncExternalStore } from "react";
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

/** One target a control refreshes; the shape both fold callers already hold. */
export interface RateLimitQueueTargetRef {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
}

/** NUL cannot occur in a provider id or a profile id, so it separates safely. */
const TARGET_KEY_SEPARATOR = "\u0000";

/**
 * Whether ANY of `targets` currently sits in the queue (queued or fetching),
 * folded over the same registry as {@link useRateLimitQueueTargetPhase}.
 *
 * This is what a refresh BUTTON should gate on, rather than the lane-wide
 * draining flag. `RefreshIconButton` disables on its `refreshing` value and its
 * trigger no-ops while set, with no timeout cap on the external half - so a
 * lane-wide gate turned every ephemeral control off whenever anything was
 * queued anywhere, including a background sweep of an unrelated provider. It
 * also made the queue's force promotion unreachable from the UI: a queued pull
 * is promoted by a click, but the click was blocked in exactly the state where
 * promoting matters. The fold returns a primitive, so `useSyncExternalStore`
 * needs no snapshot cache.
 */
export function useAnyRateLimitQueueTargetPending(
  targets: ReadonlyArray<RateLimitQueueTargetRef>,
): boolean {
  const queueScope = useRateLimitQueueScope();
  const hostId = queueScope === null ? null : queueScope.hostId;
  // Keyed on the target identities rather than the array reference: callers
  // rebuild these lists every render, and a reference dep would resubscribe on
  // each one.
  const targetsKey = targets
    .map(
      (target) =>
        `${target.providerId}${TARGET_KEY_SEPARATOR}${target.profileId ?? ""}`,
    )
    .join(TARGET_KEY_SEPARATOR);
  const stableTargets = useMemo<ReadonlyArray<RateLimitQueueTargetRef>>(() => {
    if (targetsKey === "") return [];
    const parts = targetsKey.split(TARGET_KEY_SEPARATOR);
    const decoded: Array<RateLimitQueueTargetRef> = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const profileId = parts[index + 1];
      decoded.push({
        providerId: parts[index] as RateLimitProviderId,
        profileId: profileId === "" ? null : profileId,
      });
    }
    return decoded;
  }, [targetsKey]);

  const getSnapshot = useCallback(() => {
    if (hostId === null) return false;
    return stableTargets.some(
      (target) =>
        getRateLimitQueueTargetPhase(
          hostId,
          target.providerId,
          target.profileId,
        ) !== null,
    );
  }, [hostId, stableTargets]);

  return useSyncExternalStore(
    subscribeRateLimitQueueTargets,
    getSnapshot,
    () => false,
  );
}
