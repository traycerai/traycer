import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * `environment.members.removePreview` for `userId`, read while a dialog names
 * them (`null` reads nothing). Keyed by environment and member, so an answer
 * only ever fills the dialog of the member it was read for. Not kept once the
 * dialog closes, and not retried behind the person's back: a refused read is
 * the query's error, which the dialog offers to read again.
 */
export function useEnvironmentMembersRemovePreviewQuery(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string,
  userId: string | null,
): UseQueryResult<EnvironmentMembersRemovePreviewResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "environment.members.removePreview">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.members.removePreview",
    params: { environmentId, userId: userId ?? "" },
    options: {
      enabled: userId !== null,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  });
}
