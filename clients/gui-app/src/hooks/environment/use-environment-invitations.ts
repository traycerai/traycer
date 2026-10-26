import { useMemo } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentInvitationsAcceptRequest,
  EnvironmentInvitationsListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import {
  authQueryKeys,
  environmentMutationKeys,
  hostQueryKeys,
} from "@/lib/query-keys";
import { toastFromAuthError } from "@/lib/auth-error-toast";

const EMPTY_PARAMS = {};

/** Reads and Accept use authn without a serving host or either host method. */
function useInvitationRoute(client: HostClient<HostRpcRegistry> | null) {
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const hostId = useReactiveHostReadiness(servingClient).hostId;
  const lists = useHostMethodSupport(hostId, "environment.invitations.list");
  const accepts = useHostMethodSupport(
    hostId,
    "environment.invitations.accept",
  );
  const direct = hostId === null || lists === false || accepts === false;
  return {
    servingClient,
    direct,
    served: !direct && lists === true && accepts === true,
  };
}

/**
 * The signed-in person's pending invitations. Older serving tiers use the
 * same authn routes directly, so identity reads never need to accept a team
 * before its grant is shown. Both caches are partitioned by the viewer.
 */
export function useEnvironmentInvitationsQuery(
  client: HostClient<HostRpcRegistry> | null,
): UseQueryResult<EnvironmentInvitationsListResponse> {
  const route = useInvitationRoute(client);
  const viewerUserId = useCloudChatViewerId();
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const rpc = useHostQuery<HostRpcRegistry, "environment.invitations.list">({
    cacheKeyIdentity: [viewerUserId],
    client: route.servingClient,
    method: "environment.invitations.list",
    params: EMPTY_PARAMS,
    options: {
      enabled: route.served && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
  });
  const direct = useQuery(
    queryOptions({
      queryKey: authQueryKeys.environmentInvitations(auth, viewerUserId),
      queryFn: ({ signal }) => {
        if (auth === null)
          throw new Error("Sign in to review team invitations.");
        return auth.listEnvironmentInvitations(signal);
      },
      enabled: route.direct && auth !== null && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    }),
  );
  return route.direct ? direct : rpc;
}

/** Accepts one invitation; the team then lists among the person's environments. */
export function useEnvironmentInvitationAcceptMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  const route = useInvitationRoute(client);
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const viewerUserId = useCloudChatViewerId();
  const queryClient = useQueryClient();
  const rpc = useHostScopedMutationForClient(route.servingClient, {
    method: "environment.invitations.accept",
    mutationKey: environmentMutationKeys.invitationsAccept(),
    errorMessage: "Couldn't accept this invitation. Try again.",
    invalidateMethods: ["environment.invitations.list", "environment.list"],
  });
  const direct = useMutation({
    mutationKey: environmentMutationKeys.invitationsAccept(),
    mutationFn: (request: EnvironmentInvitationsAcceptRequest) => {
      if (auth === null) throw new Error("Sign in to accept this invitation.");
      return auth.acceptEnvironmentInvitation(request.environmentId);
    },
    onMutate: () => ({ auth, viewerUserId }),
    onSuccess: async (_answer, _request, captured) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: authQueryKeys.environmentInvitations(
            captured.auth,
            captured.viewerUserId,
          ),
        }),
        queryClient.invalidateQueries({
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "environment.list",
            ),
        }),
      ]);
    },
    onError: (error) =>
      toastFromAuthError(error, "Couldn't accept this invitation. Try again."),
  });
  return route.direct ? direct : rpc;
}
