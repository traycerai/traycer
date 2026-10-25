import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useTeamViewingHost } from "./use-team-viewing-host";

/**
 * The client a configuration's pool-only read is sent through. In a build
 * with a server pool every client sends it to the pool, so no host has to be
 * picked or running; in one without, the picked host serves it, falling back
 * to the surface's own.
 */
export function useConfigurationReadClient(): HostClient<HostRpcRegistry> {
  const scope = useTeamViewingHost();
  const surface = useHostClient();
  return scope.client ?? surface;
}
