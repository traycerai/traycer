import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyResetRequest,
  ProvidersFallbackPolicyResetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

interface FallbackPolicyResetContext {
  readonly hostId: string | null;
}

/**
 * Resets the whole fallback policy on the SURFACE's host - the danger zone.
 *
 * No `onError` toast, for the same reason as the save mutation beside it: the
 * panel is an inline-error surface and the caller dispatches its own
 * `save-failed`, which prints the reason under the danger zone rather than in a
 * toast that cannot say which action failed.
 *
 * ## Why this INVALIDATES where the save writes in place
 *
 * The two look symmetrical and are not. `set` returns the policy that is now
 * stored, so writing it into the cache is exact. `reset` returns the DEFAULT
 * policy - empty model groups - and also clears the seed marker, which means the
 * very next read of this row re-seeds the default groups and marks the user
 * (D116/D127). So the response is accurate only until something reads again, and
 * writing it in place would leave the panel showing NO model groups while the
 * engine's next tier rung resolves against a full seeded set. That is a rendered
 * status that lies about live data, not a one-frame cosmetic lag.
 *
 * Invalidating instead makes the panel take the same path a new user takes: read
 * first, let the read seed and mark, render what came back. `onSuccess` returns
 * the invalidation promise, so `mutateAsync` does not settle until the refetch
 * has landed and the caller can remount its editor onto fresh data rather than
 * onto the response.
 */
export function useFallbackPolicyResetMutation(): UseMutationResult<
  ProvidersFallbackPolicyResetResponse,
  HostRpcError,
  ProvidersFallbackPolicyResetRequest,
  FallbackPolicyResetContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.fallbackPolicy.reset",
    FallbackPolicyResetContext
  >({
    client,
    method: "providers.fallbackPolicy.reset",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.resetFallbackPolicy(),
      // Captured before dispatch, as on the save: the host can change under a
      // slow call, and writing the result into the new host's cache slot would
      // show one machine's policy under another's name.
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      // Returns the promise on purpose: TanStack awaits a promise returned from
      // `onSuccess` before `mutateAsync` settles, which is what lets the caller
      // treat "the reset is done" as "the refetch has landed".
      onSuccess: async (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            ctx.hostId,
            "providers.fallbackPolicy.get",
          ),
        });
      },
    },
  });
}
