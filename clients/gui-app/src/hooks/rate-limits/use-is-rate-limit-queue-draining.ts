import { useSyncExternalStore } from "react";
import {
  isRateLimitQueueDraining,
  subscribeRateLimitQueueDraining,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Reactively projects whether the `ephemeralProcess` serial queue currently has
 * a subprocess fetch in flight. Backs the popover's "disable Refresh-all while
 * draining" state. Both the subscribe and snapshot functions are stable module
 * references returning a primitive boolean, so `useSyncExternalStore` never
 * re-subscribes or tears on identity.
 */
export function useIsRateLimitQueueDraining(): boolean {
  return useSyncExternalStore(
    subscribeRateLimitQueueDraining,
    isRateLimitQueueDraining,
    isRateLimitQueueDraining,
  );
}
