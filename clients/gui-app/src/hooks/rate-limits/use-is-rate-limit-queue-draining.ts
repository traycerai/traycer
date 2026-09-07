import { useSyncExternalStore } from "react";
import {
  isRateLimitQueueDraining,
  subscribeRateLimitQueueDraining,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

/** Both the subscribe and snapshot functions are stable module references returning a primitive boolean, so `useSyncExternalStore` never re-subscribes or tears on identity. */
export function useIsRateLimitQueueDraining(): boolean {
  return useSyncExternalStore(
    subscribeRateLimitQueueDraining,
    isRateLimitQueueDraining,
    isRateLimitQueueDraining,
  );
}
