import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";

/**
 * Project default-host owner identity from the live client. Subscribe via the connection registry so a same-`hostId` public-key rotation is observed as a row change.
 */
export function useReactiveOwnerIdentityKey<
  Registry extends VersionedRpcRegistry,
>(client: HostClient<Registry> | null): string | null {
  const subscribe = useCallback((callback: () => void) => {
    return subscribeAnyHostRowChanged(callback);
  }, []);
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
