import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * Which of `hostIds` advertised `method` in their last handshake - the
 * several-host form of `useHostSupportsMethod`, for a surface that chooses
 * among hosts rather than gating one. Fails closed the same way: a host with
 * no completed handshake is not in the set.
 */
export function useHostsAdvertisingMethod(
  hostIds: ReadonlyArray<string>,
  method: string,
): ReadonlySet<string> {
  const idsKey = hostIds.join("\n");
  // A string stamp because `useSyncExternalStore` compares with `Object.is`:
  // a manifest change that moves no listed host re-renders nothing.
  const getStamp = useCallback(
    () =>
      idsKey
        .split("\n")
        .filter(
          (hostId) =>
            hostId.length > 0 &&
            getNegotiatedHostMethods(hostId)?.has(method) === true,
        )
        .join("\n"),
    [idsKey, method],
  );
  const stamp = useSyncExternalStore(
    subscribeNegotiatedManifests,
    getStamp,
    getStamp,
  );
  return useMemo(
    () => new Set(stamp.split("\n").filter((id) => id.length > 0)),
    [stamp],
  );
}
