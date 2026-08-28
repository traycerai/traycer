import { useCallback, useRef, useSyncExternalStore } from "react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The three states a negotiated-version read can be in, for ONE host.
 *
 * - `null` - no client/bound host, no handshake has completed yet, or the
 *   method is present but its canonical version was not recorded. Nothing is
 *   known about whether the method meets a version gate.
 * - `false` - the host completed a handshake and did not advertise the method.
 * - a `{ major, minor }` version - the host advertised it at that version.
 */
export type NegotiatedMethodVersion = SchemaVersion | false | null;

/**
 * The registry read, in the three states above. The registry's own version
 * getter returns `null` for both "unknown" and "absent"; composing it with the
 * stable method set separates known absence. A name-only legacy record leaves
 * a present method's version unknown, which remains `null`, and every consumer
 * here shares this one composition rather than re-deriving it.
 */
function readNegotiatedMethodVersion(
  hostId: string,
  method: string,
): NegotiatedMethodVersion {
  const methods = getNegotiatedHostMethods(hostId);
  if (methods === null) return null;
  if (!methods.has(method)) return false;
  return getNegotiatedHostMethodVersion(hostId, method);
}

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
