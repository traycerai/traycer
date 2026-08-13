import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";

/**
 * How often the ready-session evidence is re-read. Matches the per-host
 * `useRemoteSessionPollReadiness` bound and exists for the same reason:
 * session readiness settles within seconds of a dial, the cache is a small
 * in-memory map with no change events, and an unchanged snapshot re-renders
 * nothing.
 */
const REMOTE_SESSIONS_READINESS_POLL_MS = 1_000;

/**
 * Reactive MULTI-host view of `hasReadyRemoteSession` - the fleet-shaped
 * sibling of `useRemoteSessionPollReadiness` for consumers that derive from a
 * whole directory list (the readiness controller's per-scope resolution and
 * its `anyHostDialable`), where a hook-per-row is not an option.
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
  const subscribe = useCallback((onStoreChange: () => void) => {
    const timer = setInterval(onStoreChange, REMOTE_SESSIONS_READINESS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
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
