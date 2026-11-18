import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useServedEnvironmentRow } from "@/hooks/environment/use-served-environment-row";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";

/** The picked computer's team authority, never the currently selected settings page's. */
export function useCanSetRemoteAccess(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  principal: EnvironmentStatusResponse["principal"],
  enabled: boolean,
): boolean {
  const supported = useHostMethodSupport(hostId, "host.remoteAccess.set");
  const needsTeamRole =
    enabled && supported === true && principal?.kind === "team";
  const team = useServedEnvironmentRow(client, hostId, needsTeamRole);
  if (!enabled || supported !== true) return false;
  if (principal?.kind !== "team") return true;
  return (
    team !== null &&
    team.ownerKind === "organization" &&
    mayChangeConfiguration(configurationRoleOf(team))
  );
}
