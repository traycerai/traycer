import { useMemo } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFilters,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentInvitationsAcceptRequest,
  EnvironmentInvitationsListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  useHostQuery,
  useHostQueryEntryHash,
} from "@/hooks/host/use-host-query";
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

/**
 * Every cache entry an invitations read can land in, on either route.
 *
 * Deliberately all of them and not the one being served: a caller that matched
 * only the route it happens to be served from would leave a read in flight on
 * the other the moment host readiness moved, and that read can still answer
 * into the cache afterwards.
 */
function invitationReadFilters(): readonly QueryFilters[] {
  return [
    {
      predicate: (query) =>
        hostQueryKeys.matchesMethodOnAnyHost(
          query.queryKey,
          "environment.invitations.list",
        ),
    },
    { queryKey: authQueryKeys.environmentInvitationsAll() },
  ];
}

/**
 * The identity of the cache entry the serving route's read lands in — its
 * `queryHash`.
 *
 * This is what a caller needs to say "the read I am RENDERING has answered
 * since I asked", and it holds the evidence to ONE entry. The route is too
 * coarse for that: one route holds one entry per host scope and per identity it
 * has been read under, so a question certified while one entry served would
 * survive a move to another of that route's entries, and the stale list that
 * entry has cached would be read as an answer to a question it predates.
 *
 * Every branch below mirrors {@link useEnvironmentInvitationsQuery}: the same
 * route, the same viewer, the same auth, the same params, and the same
 * `route.direct` choice between the two. That is what makes this the identity
 * of the entry whose data that hook returns in the same render, rather than an
 * identity that merely tends to agree with it.
 *
 * Neither does the cache answer this, which is the subtler half. TanStack hands
 * a render the data of the key it was given and moves the observer to that key
 * in an effect, so in the one render where the key changes a cache-side lookup
 * still names the entry the app has just stopped reading — and that is the
 * render in which a caller judging the new data decides.
 */
export function useEnvironmentInvitationsEntryHash(
  client: HostClient<HostRpcRegistry> | null,
): string {
  const route = useInvitationRoute(client);
  const viewerUserId = useCloudChatViewerId();
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const queryClient = useQueryClient();
  const rpc = useHostQueryEntryHash<
    HostRpcRegistry,
    "environment.invitations.list"
  >({
    client: route.servingClient,
    method: "environment.invitations.list",
    params: EMPTY_PARAMS,
    cacheKeyIdentity: [viewerUserId],
  });
  // Hashed by the client, like the RPC route's above, so it is spelled the way
  // the cache files it — the app replaces TanStack's `queryKeyHashFn`.
  const direct = queryClient.defaultQueryOptions({
    queryKey: authQueryKeys.environmentInvitations(auth, viewerUserId),
  }).queryHash;
  return route.direct ? direct : rpc;
}

/**
 * Stops every invitations read in flight, on both routes, so the
 * caller's own request is the next one made.
 *
 * A caller that has to know whether an invitation exists *now* needs that: a
 * read already in flight is joined rather than replaced — TanStack cancels for
 * `cancelRefetch` only when the query has data to fall back on
 * (`Query.fetch`), and otherwise hands back the running request's promise —
 * and the reply it would join can carry a snapshot the server assembled before
 * whatever prompted the call.
 *
 * Note which cancel this is, because the two differ where it matters. This one
 * REVERTS, which is `cancelQueries`' default, and a reverted cancel resolves
 * whoever was awaiting that request with the cache as it stands — the answer
 * from before their question. `refetch({ cancelRefetch: true })` cancels
 * SILENTLY instead, and a silent cancel hands its caller the replacement
 * retryer's promise, so that caller gets the fresh result and needs none of
 * this care.
 *
 * It returns nothing on purpose, and the caller asks in the same synchronous
 * step. `cancelQueries` rejects each retryer as it walks the matches, and a
 * rejected retryer is what makes the next `fetch` start a request instead of
 * joining one, so there is nothing to wait for — and nothing to wait for means
 * no observer is left between a cancelled read and its replacement. The cost
 * is the cancelled read's own wait: its observers wait for the replacement,
 * which arrives on the same key.
 */
export function cancelEnvironmentInvitationReads(
  queryClient: QueryClient,
): void {
  for (const filters of invitationReadFilters())
    void queryClient.cancelQueries(filters);
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
