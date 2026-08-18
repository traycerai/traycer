import { useCallback, useSyncExternalStore } from "react";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  isRateLimitFetchPending,
  subscribeRateLimitQueue,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Reactively projects whether a pull for exactly this provider/profile on the
 * subtree's host is waiting in the `ephemeralProcess` lane or running. Backs
 * the popover row's "Refreshing" label: the row's own query `isFetching` only
 * turns on once its pull reaches the front of the lane, which can be tens of
 * seconds after a click when another probe is already running - during which
 * the click looked ignored. Reads the same host binding
 * `useRateLimitQueueScope` enqueues under, so the flag and the enqueue always
 * name one host.
 */
export function useIsRateLimitFetchPending(
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const hostId = useReactiveActiveHostId();
  const getSnapshot = useCallback(
    () =>
      hostId !== null && isRateLimitFetchPending(hostId, providerId, profileId),
    [hostId, profileId, providerId],
  );
  return useSyncExternalStore(
    subscribeRateLimitQueue,
    getSnapshot,
    getSnapshot,
  );
}

/**
 * The any-of form for a surface that owns several profiles at once (the
 * popover's per-provider block, whose refresh action enqueues one batch over
 * every eligible profile). A hook per profile is not an option - the profile
 * list changes length as logins come and go - so this subscribes once and folds
 * the keys into a single boolean.
 *
 * `targets` must be referentially stable across renders that don't change it
 * (the callers memoize the same array they hand the queue), since it is the
 * snapshot callback's identity input.
 */
export function useIsAnyRateLimitFetchPending(
  targets: ReadonlyArray<{
    readonly providerId: RateLimitProviderId;
    readonly profileId: string | null;
  }>,
): boolean {
  const hostId = useReactiveActiveHostId();
  const getSnapshot = useCallback(
    () =>
      hostId !== null &&
      targets.some((target) =>
        isRateLimitFetchPending(hostId, target.providerId, target.profileId),
      ),
    [hostId, targets],
  );
  return useSyncExternalStore(
    subscribeRateLimitQueue,
    getSnapshot,
    getSnapshot,
  );
}
