import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The team computer asked to count a member's running work: one of the
 * team's hosts (authn's list) this app can reach now, the window's own host
 * first when it is one of them. Null when none is.
 */
function teamCountingHost(
  teamHostIds: ReadonlyArray<string>,
  connectable: ReadonlyArray<string>,
  ownHostId: string | null,
): string | null {
  const reachable = teamHostIds.filter((hostId) =>
    connectable.includes(hostId),
  );
  if (ownHostId !== null && reachable.includes(ownHostId)) return ownHostId;
  return reachable[0] ?? null;
}

/**
 * `environment.members.removePreview` for `userId`, asked of a team computer
 * while the removal confirm names them (`null` reads nothing), for the
 * member's running turns and terminals there. Asked once per opening: not
 * kept once the confirm closes, not retried, not re-read on focus. With no
 * team computer reachable it asks nothing.
 */
export function useEnvironmentMemberWorkNowQuery(
  environmentId: string,
  userId: string | null,
): UseQueryResult<EnvironmentMembersRemovePreviewResponse, HostRpcError> {
  const teamHosts = useEnvironmentHostLists(
    [environmentId],
    userId !== null,
  ).hostsByEnvironmentId.get(environmentId);
  const connectable = useConnectableHostIds().hostIds;
  const ownHostId = useEffectiveHostId();
  const hostId = teamCountingHost(
    teamHosts?.map((host) => host.hostId) ?? [],
    connectable,
    ownHostId,
  );
  const hostClient = useHostClientForHostId(hostId);
  return useHostQuery<HostRpcRegistry, "environment.members.removePreview">({
    cacheKeyIdentity: undefined,
    // A null host follows the window's host, which is not a team computer.
    client: hostId === null ? null : hostClient,
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
