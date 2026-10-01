import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

export function useProvidersLoginOwnership(): boolean {
  return useProvidersLoginOwnershipForClient(useHostClient());
}

/** Ownership is safe only when this surface's host supports both halves. */
export function useProvidersLoginOwnershipForClient(
  client: HostClient<HostRpcRegistry> | null,
): boolean {
  const hostId = client?.getActiveHostId() ?? null;
  const start = useHostMethodSchemaVersion(hostId, "providers.startLogin");
  const cancel = useHostMethodSchemaVersion(hostId, "providers.cancelLogin");
  return (
    start?.major === 1 &&
    start.minor >= 4 &&
    cancel?.major === 1 &&
    cancel.minor >= 2
  );
}
