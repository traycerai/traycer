import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The picker's host is the placement's RESOLVED host - the one the chat is
 * created on, whichever tier answered - never the raw request field: an
 * unnamed request resolves through the Epic's pin or session host while the
 * app-wide host may already be elsewhere. Fixed for EVERY resolved host, even
 * while its client is still resolving (the fixed scope accepts a null client)
 * - falling back to the active host would let the user browse another host's
 * folders into a draft the submit then applies to the resolved one. `null`
 * (no host resolved at all) is the only case that follows the active host.
 */
export function modalWorkspaceHostScope(
  resolvedHostId: string | null,
  hostClient: HostClient<HostRpcRegistry> | null,
): HostWorkspaceControlsHostScope {
  return resolvedHostId === null
    ? { kind: "active" }
    : { kind: "fixed", hostId: resolvedHostId, hostClient };
}
