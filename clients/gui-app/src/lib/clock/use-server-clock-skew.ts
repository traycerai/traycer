import { useSyncExternalStore } from "react";
import { appServerClock } from "@/lib/clock/app-server-clock";
import type { ServerClockState } from "@traycer-clients/shared/clock/server-time-offset-tracker";

/**
 * Subscribes a component to the app-wide clock verdict.
 *
 * `currentState()` returns the tracker's stored state object, which is only
 * replaced when the verdict or offset actually changes, so this is a stable
 * `useSyncExternalStore` snapshot with no memo required.
 */
export function useServerClockSkew(): ServerClockState {
  return useSyncExternalStore(
    (onStoreChange) => appServerClock.subscribe(onStoreChange),
    () => appServerClock.currentState(),
    () => appServerClock.currentState(),
  );
}
