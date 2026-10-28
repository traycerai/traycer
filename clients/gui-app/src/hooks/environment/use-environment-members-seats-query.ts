import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersSeatsResponse } from "@traycer/protocol/host/environment/contracts";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * `environment.members.seats` for the invite sheet, read while it is open on a
 * host that serves it. Not kept once the sheet closes, so each opening reads
 * the seats as they are then, and not retried behind the person's back: a
 * refused read is the query's error, which the sheet offers to read again.
 */
export function useEnvironmentMembersSeatsQuery(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string,
  enabled: boolean,
): UseQueryResult<EnvironmentMembersSeatsResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "environment.members.seats">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.members.seats",
    params: { environmentId },
    options: {
      poll: true,
      enabled,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  });
}
