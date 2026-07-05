import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";

/**
 * Reactively projects the canonical remote-aware owner identity (R-1) for the
 * "default host" scope from a `HostClient`'s live active host + signed-in
 * user - `null` until both are known.
 *
 * Subscribes via `client.onChange`, so a same-`hostId` public-key rotation -
 * which `HostClient.bind`'s `sameHostTransport` check now treats as a
 * `host-updated` transition - is observed the same way a genuine host swap
 * is, instead of requiring an unrelated re-render to pick up the fresh key.
 */
export function useReactiveOwnerIdentityKey<
  Registry extends VersionedRpcRegistry,
>(client: HostClient<Registry> | null): string | null {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      return client.onChange(callback);
    },
    [client],
  );
  const getSnapshot = useCallback(() => readOwnerIdentityKey(client), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function readOwnerIdentityKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  return remoteAwareOwnerIdentityKey(
    client?.getActiveHost() ?? null,
    client?.getRequestContextUserId() ?? null,
  );
}
