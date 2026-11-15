import type { RequestContext } from "@traycer/protocol/auth/request-context";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { noteHostMembershipChanged } from "@/lib/host/local-admission-invalidation";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EnvironmentInvitationsAcceptRequest,
  EnvironmentInvitationsListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostBinding } from "@/lib/host";
import {
  authQueryKeys,
  environmentMutationKeys,
  hostQueryKeys,
} from "@/lib/query-keys";
import { toastFromAuthError } from "@/lib/auth-error-toast";

/**
 * The signed-in person's pending invitations, read from authn: an identity
 * read never needs a serving host, so a team's grant shows before the person
 * accepts it. The cache is partitioned by the viewer.
 */
export function useEnvironmentInvitationsQuery(): UseQueryResult<EnvironmentInvitationsListResponse> {
  const viewerUserId = useCloudChatViewerId();
  const auth = useHostBinding()?.auth ?? null;
  return useQuery(
    queryOptions({
      queryKey: authQueryKeys.environmentInvitations(auth, viewerUserId),
      queryFn: ({ signal }) => {
        if (auth === null)
          throw new Error("Sign in to review team invitations.");
        return auth.listEnvironmentInvitations(signal);
      },
      enabled: auth !== null && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    }),
  );
}

/**
 * The identity of the cache entry {@link useEnvironmentInvitationsQuery}
 * renders from — its `queryHash`.
 *
 * This is what a caller needs to say "the read I am RENDERING has answered
 * since I asked", and it holds the evidence to ONE entry: there is one entry
 * per sign-in and viewer, so a question certified while one entry served would
 * otherwise survive a move to another, and the stale list that entry has
 * cached would be read as an answer to a question it predates.
 *
 * It is built from the same auth and viewer as that hook, in the same render,
 * which is what makes it the identity of the entry whose data the hook returns
 * rather than one that merely tends to agree with it.
 *
 * Neither does the cache answer this, which is the subtler half. TanStack hands
 * a render the data of the key it was given and moves the observer to that key
 * in an effect, so in the one render where the key changes a cache-side lookup
 * still names the entry the app has just stopped reading — and that is the
 * render in which a caller judging the new data decides.
 */
export function useEnvironmentInvitationsEntryHash(): string {
  const viewerUserId = useCloudChatViewerId();
  const auth = useHostBinding()?.auth ?? null;
  const queryClient = useQueryClient();
  // Hashed by the client so it is spelled the way the cache files it — the app
  // replaces TanStack's `queryKeyHashFn`.
  return queryClient.defaultQueryOptions({
    queryKey: authQueryKeys.environmentInvitations(auth, viewerUserId),
  }).queryHash;
}

/**
 * Stops every invitations read in flight, under every sign-in, so the caller's
 * own request is the next one made.
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
  void queryClient.cancelQueries({
    queryKey: authQueryKeys.environmentInvitationsAll(),
  });
}

/** Accepts one invitation; the team then lists among the person's environments. */
export function useEnvironmentInvitationAcceptMutation() {
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const viewerUserId = useCloudChatViewerId();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  // The team's computers join the person's host list now, not at the next
  // picker open or poll; and only for the sign-in that accepted: an account
  // switched while the call was out tells the new account nothing.
  const afterAccepted = (captured: {
    readonly context: RequestContext | null;
    readonly localHostId: string | null;
  }): void => {
    if (
      captured.context === null ||
      captured.context.abortSignal.aborted ||
      auth?.getRequestContextProvider().current() !== captured.context
    )
      return;
    if (captured.localHostId !== null)
      noteHostMembershipChanged(captured.localHostId);
    void queryClient.invalidateQueries({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    void binding?.directory.refresh();
    requestFleetRefresh(runnerHost);
  };
  return useMutation({
    mutationKey: environmentMutationKeys.invitationsAccept(),
    mutationFn: (request: EnvironmentInvitationsAcceptRequest) => {
      if (auth === null) throw new Error("Sign in to accept this invitation.");
      return auth.acceptEnvironmentInvitation(request.environmentId);
    },
    onMutate: () => ({
      auth,
      viewerUserId,
      context: auth?.getRequestContextProvider().current() ?? null,
      localHostId: readLocalHostIdSnapshot(),
    }),
    onSuccess: async (answer, _request, captured) => {
      if (answer.outcome === "accepted") afterAccepted(captured);
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
}
