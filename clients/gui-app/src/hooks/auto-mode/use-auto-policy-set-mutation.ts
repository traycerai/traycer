import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AutoPolicyGetResponse,
  AutoPolicySetRequest,
  AutoPolicySetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { autoModeMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetAutoPolicyContext = {
  readonly hostId: string | null;
};

/**
 * Saves the account's auto-mode policy through the surface's host.
 *
 * Last-write-wins on the server, so the ORDER these reach the host is the
 * client's job - the method policy table puts `autoPolicy.set` in `fifo` for
 * that reason, and this hook must never be given a "skip if one is in flight"
 * guard, which would drop the newest text.
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
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      onSuccess: (data, variables, ctx) => {
        if (ctx.hostId === null) return;
        queryClient.setQueriesData<AutoPolicyGetResponse>(
          {
            queryKey: hostQueryKeys.methodScope(ctx.hostId, "autoPolicy.get"),
          },
          (previous) => ({
            body: variables.body,
            updatedAt: data.updatedAt,
            source: previous?.source ?? "account",
          }),
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the Auto mode policy."),
    },
  });
}
