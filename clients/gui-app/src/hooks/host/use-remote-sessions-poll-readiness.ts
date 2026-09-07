import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  hasReadyRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";

/** Multi-host hasReadyRemoteSession lookup. Snapshot identity changes only when some listed host's readiness changes. */
export function useRemoteSessionsPollReadiness(
  hostIds: ReadonlyArray<string>,
): (hostId: string) => boolean {
  const idsKey = hostIds.join("\n");
  // The stamp below is unchanged, so a wake that moved no listed host still re-renders nothing.
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
