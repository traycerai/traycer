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
