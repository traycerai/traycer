import { useCallback, useRef, useSyncExternalStore } from "react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";

/** The three states a negotiated-version read can be in, for ONE host. */
export type NegotiatedMethodVersion = SchemaVersion | false | null;

/** A name-only legacy record leaves a present method's version unknown, which remains `null`, and every consumer here shares this one composition rather than re-deriving it. */
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
 * Version-bearing counterpart to {@link useHostMethodSupport}. Decisions that could strand data must distinguish `null` (unknown) from `false` (known absent).
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

/** Never-dialled hosts read null, not too-old. Snapshot is content-keyed so a fresh map does not loop. */
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
