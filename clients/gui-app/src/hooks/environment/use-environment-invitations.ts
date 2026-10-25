import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentInvitationsListResponse } from "@traycer/protocol/host/environment/contracts";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { environmentMutationKeys } from "@/lib/query-keys";

const EMPTY_PARAMS = {};

/**
 * The teams waiting for the signed-in person's Accept, as
 * `environment.invitations.list` answers it. Account-wide like
 * `environment.list`, so it is the pool's in a build with one, and it is the
 * viewer's, so its key carries the viewer. Not asked of a host that does not
 * serve it: an older host joins the person on its own (no Accept step).
 */
export function useEnvironmentInvitationsQuery(
  client: HostClient<HostRpcRegistry> | null,
): UseQueryResult<EnvironmentInvitationsListResponse, HostRpcError> {
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const hostId = useReactiveHostReadiness(client).hostId;
  const served =
    useHostMethodSupport(hostId, "environment.invitations.list") === true;
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery<HostRpcRegistry, "environment.invitations.list">({
    cacheKeyIdentity: [viewerUserId],
    client: servingClient,
    method: "environment.invitations.list",
    params: EMPTY_PARAMS,
    options: {
      enabled: served && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
  });
}

/** Accepts one invitation; the team then lists among the person's environments. */
export function useEnvironmentInvitationAcceptMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  return useHostScopedMutationForClient(servingClient, {
    method: "environment.invitations.accept",
    mutationKey: environmentMutationKeys.invitationsAccept(),
    errorMessage: "Couldn't accept this invitation. Try again.",
    invalidateMethods: ["environment.invitations.list", "environment.list"],
  });
}
