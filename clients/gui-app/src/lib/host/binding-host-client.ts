import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/** The ONE home for "given a runtime binding, which host client does it mean". */

/** The client for THIS SUBTREE. */
export function resolveSubtreeHostClient(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  effectiveHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  if (binding === null) {
    return null;
  }
  if (typeof binding.hostId === "string") {
    return binding.hostClient;
  }
  return binding.hostClient.createRequesterForHostId(effectiveHostId);
}

/** The APP-WIDE host, DELIBERATELY, whatever subtree the caller is in. */
export function resolveAppWideHostClient(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  effectiveHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  if (binding === null) {
    return null;
  }
  return binding.hostClient.createRequesterForHostId(effectiveHostId);
}

/** A requester for a host ID explicitly named by the caller. */
export function resolveNamedHostClient(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  hostId: string,
): HostClient<HostRpcRegistry> | null {
  if (binding === null) {
    return null;
  }
  return binding.hostClient.createRequesterForHostId(hostId);
}
