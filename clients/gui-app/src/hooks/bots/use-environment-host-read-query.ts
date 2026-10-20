import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  EnvironmentBindingReadRequest,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";

const EMPTY_PARAMS = {};

/**
 * The one environment `hostId`, the host behind `client`, is bound to, for
 * the signed-in user. `explicit: false` means the owner never bound it and it
 * sits in their personal environment - the only default there is.
 *
 * Per host by construction: a binding is a fact about one machine, so the
 * caller names the host (the scoped Settings client and its host id) and this
 * hook never reaches for the app-wide one on its own. In a build with a pool
 * the answer is the pool's (`environment.binding.read { hostId }`, keyed by
 * the viewer, as `useEnvironmentListQuery` explains); without one it is the
 * host's own (`environment.host.read`). Either way it lands in the entry
 * `useHostEnvironmentBindings` reads for the same host, and a bind writes
 * through to it. Both reads are declared because hooks cannot be called
 * conditionally; the build's arm is the only one ever enabled.
 */
export function useEnvironmentHostReadQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): UseQueryResult<EnvironmentHostBinding, HostRpcError> {
  const fromPool = readsHostBindingsFromPool();
  const poolClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const viewerUserId = useCloudChatViewerId();
  // `hostId` is null only while the scope has no host, when neither read is
  // enabled; the empty id is never sent.
  const poolParams = useMemo<EnvironmentBindingReadRequest>(
    () => ({ hostId: hostId ?? "" }),
    [hostId],
  );
  const pooled = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    cacheKeyIdentity: [viewerUserId],
    client: poolClient,
    method: "environment.binding.read",
    params: poolParams,
    options: {
      enabled:
        fromPool && enabled && hostId !== null && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
  });
  const own = useHostQuery<HostRpcRegistry, "environment.host.read">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.host.read",
    params: EMPTY_PARAMS,
    options: { enabled: !fromPool && enabled, refetchOnWindowFocus: false },
  });
  return fromPool ? pooled : own;
}
