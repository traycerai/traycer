import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyResetRequest,
  ProvidersFallbackPolicyResetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { fallbackPolicyWriteScope } from "@/hooks/providers/use-fallback-policy-set-mutation";
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
 * first, let the read seed and mark, render what came back.
 *
 * ## Why the invalidation does NOT refetch, and does not report anything
 *
 * `refetchType: "none"` marks the row stale and stops there. The version before
 * it let the invalidation refetch and returned the promise, on the reasoning
 * that awaiting `onSuccess` made `mutateAsync` settle only once the refetch had
 * landed - so the caller could treat a settled reset as fresh data. That is
 * false, and not marginally: `invalidateQueries` delegates to `refetchQueries`,
 * which does `if (!fetchOptions.throwOnError) promise = promise.catch(noop)` on
 * every query it touches and then `Promise.all(promises).then(noop)`. Nothing
 * here passes `throwOnError`, so a refetch that FAILS resolves this promise
 * exactly like one that succeeded, and the caller's remount then re-seeded its
 * editor from whatever the cache still held - the policy from BEFORE the reset,
 * rendered as the result of the reset.
 *
 * A promise that cannot distinguish success from failure is not a signal, so it
 * is not offered as one. The one caller that must know performs its own read and
 * reads its outcome (`refetchPolicy` in `fallback-settings-panel.tsx`); the
 * staleness marked here is for every OTHER observer of this row, which will read
 * again on its next mount rather than serve a policy this call just replaced.
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
      // The SAME scope the save and the restore take - three methods writing
      // one row, and the coordinator's queue key cannot order two methods
      // against each other at all. It matters most on this one: a reset
      // INVALIDATES where the save writes in place, so a save landing after a
      // reset leaves the panel showing a policy the row no longer holds.
      scope: fallbackPolicyWriteScope(client.getActiveHostId()),
      // Captured before dispatch, as on the save: the host can change under a
      // slow call, and writing the result into the new host's cache slot would
      // show one machine's policy under another's name.
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      // Synchronous, and returns nothing to await. With `refetchType: "none"`
      // there is no fetch to wait for, and a settled `mutateAsync` means only
      // what it says: the host confirmed the reset.
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            ctx.hostId,
            "providers.fallbackPolicy.get",
          ),
          refetchType: "none",
        });
      },
    },
  });
}
