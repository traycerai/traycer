import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import {
  readNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/lib/host/read-negotiated-method-version";

// The three-state read itself lives in `lib/host/read-negotiated-method-version`
// (it is also a dispatch-time read for non-hook code); the hooks below are its
// subscribing counterparts.
export type { NegotiatedMethodVersion };

/**
 * The version `method` negotiated on the host currently addressed by `client`.
 *
 * This is the version-bearing counterpart to {@link useHostMethodSupport}.
 * Any decision that could STRAND data must distinguish `null` from `false`:
 * treating `null` as `false` asserts an absent capability without evidence,
 * while treating `false` as `null` conceals a known incompatibility. The hook
 * follows both manifest updates and client rebinding, so a dialog can safely
 * receive a host-parametric client without consulting the app-wide active host.
 */
export function useHostNegotiatedMethodVersion(
  client: HostClient<HostRpcRegistry> | null,
  method: string,
): NegotiatedMethodVersion {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const unsubscribeManifest = subscribeNegotiatedManifests(onStoreChange);
      const unsubscribeClient = client?.onChange(onStoreChange) ?? null;
      return () => {
        unsubscribeManifest();
        unsubscribeClient?.();
      };
    },
    [client],
  );
  const getSnapshot = useCallback((): NegotiatedMethodVersion => {
    const hostId = client?.getActiveHostId() ?? null;
    if (hostId === null) return null;
    return readNegotiatedMethodVersion(hostId, method);
  }, [client, method]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The same read for a LIST of hosts named by id — what a picker needs to gate
 * its rows, where the singular hook cannot help: one client per row would mean
 * one hook call per row, and the row set is dynamic.
 *
 * Hosts this client has never dialled read `null` (unknown), which is the
 * honest answer and the one a picker must not turn into "too old": the entry
 * fills in on the first completed handshake with that host, which for a
 * host-parametric surface is the moment its client resolves.
 *
 * The snapshot is CONTENT-keyed, not identity-keyed, so `useSyncExternalStore`
 * sees the same map across renders that change nothing: the registry hands back
 * referentially stable sets and versions, but the map assembled from them is
 * fresh on every call, and returning that directly would loop. Callers should
 * still memoize `hostIds` — an unstable array only costs a re-read here, but a
 * stable one keeps the whole chain quiet.
 */
export function useHostNegotiatedMethodVersions(
  hostIds: readonly string[],
  method: string,
): ReadonlyMap<string, NegotiatedMethodVersion> {
  const cacheRef = useRef<{
    readonly key: string;
    readonly versions: ReadonlyMap<string, NegotiatedMethodVersion>;
  } | null>(null);
  const getSnapshot = useCallback((): ReadonlyMap<
    string,
    NegotiatedMethodVersion
  > => {
    const entries = hostIds.map(
      (hostId) =>
        [hostId, readNegotiatedMethodVersion(hostId, method)] as const,
    );
    const key = JSON.stringify(entries);
    const cached = cacheRef.current;
    if (cached !== null && cached.key === key) return cached.versions;
    const versions = new Map(entries);
    cacheRef.current = { key, versions };
    return versions;
  }, [hostIds, method]);
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
}
