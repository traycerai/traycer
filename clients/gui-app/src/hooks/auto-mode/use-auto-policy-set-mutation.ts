import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AutoPolicyGetResponse,
  AutoPolicySetRequest,
  AutoPolicySetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  autoModeMutationKeys,
  autoPolicyWriteScope,
  hostQueryKeys,
} from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetAutoPolicyContext = {
  readonly hostId: string | null;
  /**
   * The viewer this save was made BY, captured at `onMutate` for the same
   * reason `hostId` is: an identity that moves mid-flight must not redirect the
   * write-through onto whoever is signed in when the response lands.
   */
  readonly viewerUserId: string;
};

/**
 * Saves the account's auto-mode policy through the surface's host.
 *
 * Last-write-wins on the server, so the ORDER these reach the host is the
 * client's job, and `autoPolicyWriteScope` is the thing that does it. `fifo` in
 * the method policy table is NOT: the coordinator's queue key carries the
 * params, so two saves carrying two different bodies sit in two queues and
 * race - what `fifo` buys is that an identical repeat lands rather than being
 * coalesced. This hook must also never be given a "skip if one is in flight"
 * guard, which would drop the newest text; the scope HOLDS the newer save until
 * the older one settles rather than dropping it.
 *
 * The read cache is written from the response rather than invalidated: the
 * body is the one just sent and `updatedAt` is the server's new stamp, so the
 * editor's stale-edit warning re-arms against the save it just made instead of
 * warning the user against themselves on the next keystroke. A refetch would
 * answer the same thing one round-trip later - and, on a host serving a cached
 * copy, could answer `updatedAt: null` and lose the stamp entirely.
 */
export function useAutoPolicySetMutation(): UseMutationResult<
  AutoPolicySetResponse,
  HostRpcError,
  AutoPolicySetRequest,
  SetAutoPolicyContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const viewerUserId = useCloudChatViewerId();
  return useHostMutation<
    HostRpcRegistry,
    "autoPolicy.set",
    SetAutoPolicyContext
  >({
    client,
    method: "autoPolicy.set",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: autoModeMutationKeys.setPolicy(),
      // One queue for the whole app, not one per host: the policy is one
      // account-wide record, and a save routed through host A must still be
      // ordered against a later save routed through host B.
      scope: autoPolicyWriteScope(),
      onMutate: () => ({
        hostId: client.getActiveHostId() ?? null,
        viewerUserId,
      }),
      // CANCEL, then write - see `use-auto-judge-set-mutation.ts` for the
      // measurement. The policy read has an opening-read lock, but that covers
      // only the read the EDITOR fires when it opens; a recovery sweep or a
      // `refetchOnMount: "always"` remount behind the dialog is an equally old
      // snapshot with nothing stopping it from landing after this write.
      //
      // Cancelling the VIEWER's entry alone, for the same reason the write
      // below addresses it alone: another viewer's in-flight read is not this
      // save's business, and cancelling on the method-scope prefix would reach
      // every partition under the host.
      onSuccess: async (data, variables, ctx) => {
        if (ctx.hostId === null) return;
        const queryKey = hostQueryKeys.autoPolicyForViewer(
          ctx.hostId,
          ctx.viewerUserId,
        );
        await queryClient.cancelQueries({ queryKey });
        // The VIEWER's entry, not the method scope. The read cache is
        // partitioned by the authenticated user (`useAutoPolicyQuery`), and a
        // filter on the bare method scope prefix-matches every partition under
        // this host - so a save by B would write B's policy body into A's
        // cached entry, which A is served synchronously on the next identity
        // switch. That is the cross-identity leak the read partition exists to
        // close, arriving through the write path.
        queryClient.setQueriesData<AutoPolicyGetResponse>(
          { queryKey },
          (previous) => ({
            body: variables.body,
            updatedAt: data.updatedAt,
            source: previous?.source ?? "account",
            // A completed write is the strongest evidence of a current record
            // there is - the host wrote it and seeded its own cache with it -
            // so this is the one place a `stale` or `unreadable` read state is
            // legitimately replaced rather than carried forward.
            readState: "fresh",
            // Carried, not re-derived: the shipped rules are bundled with the
            // host and have nothing to do with this write. Dropping them here
            // would make the "what the judge already blocks" row vanish the
            // moment somebody saved a policy, which is exactly when they have
            // most reason to look at it.
            shippedDefaults: previous?.shippedDefaults,
          }),
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the Auto mode policy."),
    },
  });
}
