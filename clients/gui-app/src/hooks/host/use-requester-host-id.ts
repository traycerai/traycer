import { useCallback, useSyncExternalStore } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * The host `client` addresses, as a value - `null` while it addresses none.
 *
 * Read it here, never off the client at render time. A requester pinned by
 * host id answers `null` until that host's directory row lands and keeps its
 * identity when the row does, so the compiled renderer memoized a render-time
 * read on the requester and kept `null`: a surface first rendered before its
 * host's row stayed hostless until the requester was re-minted. A row landing
 * is announced on the connection registry's coarse channel, the same one
 * `useReactiveHostReadiness` follows for the same reason.
 */
export function useRequesterHostId<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): string | null {
  const getSnapshot = useCallback(
    () => client?.getActiveHostId() ?? null,
    [client],
  );
  return useSyncExternalStore(
    subscribeAnyHostRowChanged,
    getSnapshot,
    () => null,
  );
}
