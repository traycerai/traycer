import { useMemo } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
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

/** Which route's cache slot an invitations read lands in. */
export type InvitationSlot = "direct" | "rpc";

const INVITATION_SLOTS: readonly InvitationSlot[] = ["rpc", "direct"];

/**
 * The cache entries one route's invitations read can land in.
 *
 * Both slots are named from this one function so that "the invitations reads"
 * means the same set to everything that cancels them and everything that
 * watches them. A caller matching only the slot it happens to be served from
 * would be blind to the other the moment host readiness moved the read, and a
 * caller that cancelled one set and watched another would wait on an entry
 * nothing had stopped.
 */
function invitationSlotFilters(slot: InvitationSlot): QueryFilters {
  if (slot === "direct")
    return { queryKey: authQueryKeys.environmentInvitationsAll() };
  return {
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(
        query.queryKey,
        "environment.invitations.list",
      ),
  };
}

/** The slot the invitations read is served from right now. */
export function useEnvironmentInvitationsSlot(
  client: HostClient<HostRpcRegistry> | null,
): InvitationSlot {
  return useInvitationRoute(client).direct ? "direct" : "rpc";
}

/**
 * The ONE cache entry the serving route's read lands in, or `null` where the
 * cache cannot name it.
 *
 * A caller that has to know whether a read answered SINCE it asked compares
 * this entry's `dataUpdateCount` before and after. That count is the
 * clock-free form of the question, and clock-free on purpose: `dataUpdatedAt`
 * is `Date.now()` stamped on every success, so an ask and its reply inside one
 * millisecond are indistinguishable on it and the comparison reads a confirmed
 * answer as no answer. The count rises only in the reducer's success case, so
 * it cannot tie, a failure is not an answer, and a reverting cancel restores
 * the pre-fetch count rather than raising it. `setQueryData` also dispatches a
 * success and so does raise it — nothing writes either invitations key today,
 * and a caller that starts to would be claiming an answer, so it belongs in
 * the same read rather than outside it.
 *
 * The entry is found by observation rather than by rebuilding its key.
 * `useHostQuery` owns the RPC key down to the tier that answers and the viewer
 * it is partitioned by, so a second construction of it here would match until
 * that derivation moved and then silently watch nothing. What this page needs
 * is both narrower and stable: the entry THIS app's reads are attached to.
 * Both routes' hooks hold an observer on their own slot's entry even while
 * disabled, and a slot's leftovers from a host or an identity no longer served
 * hold none. Anything other than exactly one observed entry is not an entry a
 * caller can reason about, so this says so instead of guessing.
 */
export function findEnvironmentInvitationEntry(
  queryClient: QueryClient,
  slot: InvitationSlot,
): Query | null {
  const observed = queryClient
    .getQueryCache()
    .findAll(invitationSlotFilters(slot))
    .filter((query) => query.getObserversCount() > 0);
  return observed.length === 1 ? observed[0] : null;
}

/**
 * Stops every invitations read in flight, in both routes' slots, so the
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
  for (const slot of INVITATION_SLOTS)
    void queryClient.cancelQueries(invitationSlotFilters(slot));
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
