import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { mayChangeTeamComputer } from "@/lib/environment/team-computer-role";
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
  const read = useEnvironmentHostReadQuery(client, hostId, needsTeamRole);
  const environments = useEnvironmentListQuery(needsTeamRole);
  if (!enabled || supported !== true) return false;
  if (principal?.kind !== "team") return true;
  const binding = read.kind === "binding" ? settledData(read.query) : null;
  const listed = settledData(environments);
  if (binding === null || listed === null) return false;
  const environmentId =
    binding.environment.ownerKind === "organization"
      ? binding.environment.environmentId
      : null;
  const team = listed.environments.find(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === environmentId,
  );
  return team !== undefined && mayChangeTeamComputer(team);
}

/** A read's answer once it has one and is not re-reading, else `null`. */
function settledData<T>(query: UseQueryResult<T, unknown>): T | null {
  return query.isPending || query.isFetching || query.isError
    ? null
    : query.data;
}
