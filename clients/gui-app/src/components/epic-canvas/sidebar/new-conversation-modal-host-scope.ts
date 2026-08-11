import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Fixed for EVERY non-null hostId, even while its client is still resolving
 * (the fixed scope accepts a null client) - falling back to the active host
 * for that window would let the user browse another host's folders into a
 * draft the submit then applies to the pinned host.
 */
export function modalWorkspaceHostScope(
  hostId: string | null,
  hostClient: HostClient<HostRpcRegistry> | null,
): HostWorkspaceControlsHostScope {
  return hostId === null
    ? { kind: "active" }
    : { kind: "fixed", hostId, hostClient };
}
