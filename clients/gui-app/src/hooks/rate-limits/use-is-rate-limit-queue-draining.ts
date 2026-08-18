import { useSyncExternalStore } from "react";
import {
  isRateLimitQueueDraining,
  subscribeRateLimitQueueDraining,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Reactively projects whether the `ephemeralProcess` queue currently has work
 * queued or in flight. A queue item is usually one subprocess fetch, while
 * "Refresh all" may run several profile fetches concurrently inside one item.
 * Backs the popover's "disable Refresh-all while draining" state. Both the
 * subscribe and snapshot functions are stable module references returning a
 * primitive boolean, so `useSyncExternalStore` never re-subscribes or tears on
 * identity.
 */
export function useIsRateLimitQueueDraining(): boolean {
  return useSyncExternalStore(
    subscribeRateLimitQueueDraining,
    isRateLimitQueueDraining,
    isRateLimitQueueDraining,
  );
}
