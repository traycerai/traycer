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

/**
 * Whether this exact target is queued AND already forced by a user action.
 *
 * Separated from the phase because the two queued states drive opposite UI: an
 * automatic queued item stays clickable so the click can promote it, while an
 * already-forced one has nothing left to promote and should read as pending.
 */
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
 * Whether this target's delayed follow-up read is spent, so nothing is left to
 * collect an answer we stopped waiting for.
 *
 * A surface pairs this with {@link isRateLimitQueryFailure}: suppressing a
 * still-running read is only honest while something is still coming back for
 * it, and this is the point at which nothing is. Folded over the same registry
 * as the phase, so the `notifyTargets` that publishes the follow-up's own
 * settle is what re-renders the surface into its failure state.
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

/**
 * Memo key for a target list. JSON rather than a delimiter join: a profile id
 * is a free-form string off the provider, so no separator is provably absent
 * from it, and `null` (follow the default profile) must stay distinct from `""`.
 * A delimited key collapses both - an empty id decodes back as `null`, and an
 * id containing the separator shifts every later pair - which would silently
 * query the WRONG target and report it idle while the real one is running.
 */
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

/**
 * Whether ANY of `targets` is currently FETCHING, folded over the same registry
 * as {@link useRateLimitQueueTargetPhase}.
 *
 * This is what a refresh BUTTON should gate on, rather than the lane-wide
 * draining flag. `RefreshIconButton` disables on its `refreshing` value and its
 * trigger no-ops while set, with no timeout cap on the external half - so a
 * lane-wide gate turned every ephemeral control off whenever anything was
 * queued anywhere, including a background sweep of an unrelated provider.
 *
 * `"queued"` deliberately does NOT count. An enqueue for an already-queued
 * target promotes it (`pending.force = true`), and that promotion is the only
 * thing that stops the pull being skipped by its second freshness/cool-down
 * check or reaching the host as `force: false` and being served from the gauge
 * cache - so disabling the control while queued would make the click that does
 * that work impossible. The queued row still renders its own "Queued…" label.
 *
 * This fold is the "Refresh all" control, whose popover shows that per-row
 * label, so the phase alone is enough here. A SINGLE provider's control has no
 * such label in Settings and additionally consults
 * {@link useIsRateLimitQueueTargetForced}, so an already-forced queued target
 * reads as pending rather than idle.
 *
 * The fold returns a primitive, so `useSyncExternalStore` needs no snapshot
 * cache.
 */
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
