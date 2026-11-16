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

/**
 * The person's row in their environment list for the environment a computer
 * serves, by its binding. `null` until both reads have settled, and when the
 * list holds no such row: a role not known.
 */
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

/**
 * Whether the person may change the environment the surface's host serves,
 * the one an "Add to <name>" with no expected environment uploads into.
 */
export function useMayChangeServedEnvironment(): boolean {
  const client = useHostClient();
  const hostId = useRequesterHostId(client);
  const readable =
    useHostMethodSupport(hostId, "environment.host.read") === true;
  const row = useServedEnvironmentRow(client, hostId, readable);
  return mayChangeConfiguration(row === null ? null : configurationRoleOf(row));
}

/** A read's answer once it has one and is not re-reading, else `null`. */
function settledData<T>(query: UseQueryResult<T, unknown>): T | null {
  return query.isPending || query.isFetching || query.isError
    ? null
    : query.data;
}
