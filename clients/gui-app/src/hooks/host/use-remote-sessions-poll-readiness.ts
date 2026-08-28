import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  hasReadyRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";

/**
 * Reactive MULTI-host view of `hasReadyRemoteSession` - the fleet-shaped
 * sibling of `useRemoteSessionPollReadiness` for consumers that derive from a
 * whole directory list - the readiness controller's per-scope resolution, and
 * the per-entry `isHostDialable` behind the host-scope options - where a
 * hook-per-row is not an option. (It also fed the gate's `anyHostDialable`
 * directory scan until P3.2 deleted that card; the remaining consumers ask
 * per host, not "is anything dialable".)
 *
 * Returns a lookup whose IDENTITY changes exactly when some listed host's
 * readiness changes (or the id list itself changes), so it is an honest
 * `useMemo`/`useCallback` dependency: memoized derivations that consume it
 * recompute precisely when a session becomes ready or dies, and never
 * otherwise. The snapshot is a string stamp because `useSyncExternalStore`
 * compares with `Object.is` and strings compare by value - rebuilding an
 * unchanged stamp re-renders nothing.
 */
export function useRemoteSessionsPollReadiness(
  hostIds: ReadonlyArray<string>,
): (hostId: string) => boolean {
  const idsKey = hostIds.join("\n");
  // PUSH, not poll (redesign P4.1): the session cache reports its own
  // transitions now, so this no longer runs a 1s timer for the life of the
  // window to notice a value that changes a handful of times a session. The
  // stamp below is unchanged, so a wake that moved no listed host still
  // re-renders nothing.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRemoteSessionReadiness(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () =>
      idsKey
        .split("\n")
        .filter((hostId) => hostId.length > 0 && hasReadyRemoteSession(hostId))
        .join("\n"),
    [idsKey],
  );
  const readyStamp = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const ready = new Set(readyStamp.split("\n"));
    return (hostId: string) => ready.has(hostId);
  }, [readyStamp]);
}
