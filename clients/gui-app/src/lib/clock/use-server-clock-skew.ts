import { useSyncExternalStore } from "react";
import { appServerClock } from "@/lib/clock/app-server-clock";
import type { ServerClockState } from "@traycer-clients/shared/clock/server-time-offset-tracker";

/** Subscribes a component to the app-wide clock verdict. */
export function useServerClockSkew(): ServerClockState {
  return useSyncExternalStore(
    (onStoreChange) => appServerClock.subscribe(onStoreChange),
    () => appServerClock.currentState(),
    () => appServerClock.currentState(),
  );
}
