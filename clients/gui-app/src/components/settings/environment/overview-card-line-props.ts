import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * What the Overview settings card hands each of its `settingsCardLines`
 * slots: the host the Overview shows, and its `environment.status`.
 */
export interface OverviewCardLineProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponse;
}
