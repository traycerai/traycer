import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";

/**
 * Reactively projects the canonical remote-aware owner identity (R-1) for the
 * "default host" scope from a `HostClient`'s live active host + signed-in
 * user - `null` until both are known.
 *
 * Subscribes through the connection registry, on the same schedule and for the
 * same reason as `useReactiveHostReadiness`: a same-`hostId` public-key
 * rotation (re-enrollment / corruption recovery - R-1) is a ROW change, so it
 * is observed the same way a genuine host move is instead of waiting for an
 * unrelated re-render to pick up the fresh key.
 *
 * The registry arm was load-bearing here even BEFORE P4.2 deleted the slot,
 * which is why this hook lost its `client.onChange` arm without losing any
 * coverage: a rotation on a host that was not the bound one never reached
 * `bind()` at all, so the slot event was always the narrower of the two.
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
