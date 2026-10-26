import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";

/** {@link resolvePoolTierHostClient}, memoized on the surface's client. */
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry>,
): HostClient<HostRpcRegistry>;
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> | null;
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> | null {
  return useMemo(
    () =>
      surfaceClient === null ? null : resolvePoolTierHostClient(surfaceClient),
    [surfaceClient],
  );
}

/**
 * The stream client a pool-only family's subscription is opened on: the
 * server pool's in a build that has one, else `surfaceStreamClient`, on the
 * same build-configuration rule as {@link resolvePoolTierHostClient}.
 *
 * `null` while the pool's client is not built yet, or is still the previous
 * user's: a binding is used only once its owner identity is the signed-in
 * user's, so a subscription is never opened on a session another account
 * owns.
 */
export function usePoolTierStreamClient(
  surfaceStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null,
  userId: string | null,
): IHostStreamClient<HostStreamRpcRegistry> | null {
  const pool = readProcessHostRpcTierPlan().pool;
  const streamAuth = useStreamAuthRevalidator();
  const binding = useHostStreamClientBindingFor(pool, streamAuth);
  if (pool === null) {
    return surfaceStreamClient;
  }
  const owner = remoteAwareOwnerIdentityKey(pool, userId);
  return binding !== null && owner !== null && binding.transportKey === owner
    ? binding.client
    : null;
}
