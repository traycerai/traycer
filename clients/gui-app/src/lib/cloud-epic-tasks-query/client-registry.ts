import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const clientsByHostId = new Map<string, HostClient<HostRpcRegistry>>();

/**
 * Associates a host client with its host id so the cloud-epic-tasks
 * queryFn can look it up using only the host id captured in the query key.
 * Keying by host id (instead of a per-client identifier) ensures the query
 * cache stays stable across client instances that represent the same host.
 */
export function registerCloudEpicTasksClient(
  hostId: string,
  client: HostClient<HostRpcRegistry>,
): void {
  clientsByHostId.set(hostId, client);
}

export function getCloudEpicTasksClient(
  hostId: string,
): HostClient<HostRpcRegistry> | null {
  return clientsByHostId.get(hostId) ?? null;
}

/**
 * Drops every registration. The registry is MODULE-global and a host client is
 * stable for a host's life, so production never needs this - but a suite that
 * wants to assert "the owner's client is NOT reachable" cannot express it while
 * an earlier case's registration survives, and a negative control reading
 * cross-test state is not a control at all (this was found that way: the case
 * passed a dispatch it was asserting could not happen).
 */
export function __resetCloudEpicTasksClientsForTests(): void {
  clientsByHostId.clear();
}
