import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useTeamViewingHost } from "./use-team-viewing-host";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";

/**
 * The client a configuration's pool-only read is sent through. In a build
 * with a server pool its requester owns readiness and cache scope, even when
 * no host is picked or running. Without a pool, the picked host serves it,
 * falling back to the surface's own.
 */
export function useConfigurationReadClient(): HostClient<HostRpcRegistry> {
  const scope = useTeamViewingHost();
  const surface = useHostClient();
  const client = scope.client ?? surface;
  return usePoolTierHostClient(client);
}
