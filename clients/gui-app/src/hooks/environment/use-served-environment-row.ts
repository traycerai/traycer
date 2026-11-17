import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

/** `null` until both reads settle, and when the list holds no such row. */
export function useServedEnvironmentRow(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentDescriptorV11 | null {
  const read = useEnvironmentHostReadQuery(client, hostId, enabled);
  const environments = useEnvironmentListQuery(enabled);
  if (!enabled) return null;
  const binding = read.kind === "binding" ? settledData(read.query) : null;
  const listed = settledData(environments);
  if (binding === null || listed === null) return null;
  const served = binding.environment;
  return (
    listed.environments.find(
      (environment) =>
        environment.ownerKind === served.ownerKind &&
        environment.environmentId === served.environmentId,
    ) ?? null
  );
}

export function useMayChangeServedEnvironment(): boolean {
  const client = useHostClient();
  const hostId = useRequesterHostId(client);
  const readable =
    useHostMethodSupport(hostId, "environment.host.read") === true;
  const row = useServedEnvironmentRow(client, hostId, readable);
  return mayChangeConfiguration(row === null ? null : configurationRoleOf(row));
}

function settledData<T>(query: UseQueryResult<T, unknown>): T | null {
  return query.isPending || query.isFetching || query.isError
    ? null
    : query.data;
}
