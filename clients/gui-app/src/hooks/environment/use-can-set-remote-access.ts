import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
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
  const binding = useEnvironmentHostReadQuery(client, hostId, needsTeamRole);
  const environments = useEnvironmentListQuery(client, needsTeamRole);
  if (!enabled || supported !== true) return false;
  if (principal?.kind !== "team") return true;
  if (
    binding.isPending ||
    binding.isFetching ||
    binding.isError ||
    environments.isPending ||
    environments.isFetching ||
    environments.isError
  )
    return false;
  const environmentId =
    binding.data.environment.ownerKind === "organization"
      ? binding.data.environment.environmentId
      : null;
  const team = environments.data.environments.find(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === environmentId,
  );
  return team !== undefined && configurationRoleOf(team) !== null;
}
