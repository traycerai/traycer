import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyGetResponse,
  ProvidersFallbackPolicyRestoreTierGroupsRequest,
  ProvidersFallbackPolicyRestoreTierGroupsResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  fallbackPolicyWriteScope,
  hostQueryKeys,
  providersMutationKeys,
} from "@/lib/query-keys";

interface FallbackRestoreContext {
  readonly hostId: string | null;
}

/**
 * "Restore the default model groups" on the SURFACE's host.
 *
 * No `onError` toast: inline-error surface, same as the save and reset beside
 * it, and the caller dispatches its own `save-failed`.
 *
 * ## Why this writes in place where the RESET invalidates
 *
 * The two are not symmetrical, and the difference is the seed marker. A reset
 * CLEARS it, so the policy it returns is stale the moment the next read
 * re-seeds - the response cannot be written into the cache without showing
 * empty groups the host is about to refill. A restore does not clear it: it
 * writes the seeded groups into the existing row and returns the result, so the
 * response IS what a subsequent read would produce. Writing it in place is
 * exact, and invalidating would spend a round trip to be told the same thing.
 */
export function useFallbackPolicyRestoreTierGroupsMutation(): UseMutationResult<
  ProvidersFallbackPolicyRestoreTierGroupsResponse,
  HostRpcError,
  ProvidersFallbackPolicyRestoreTierGroupsRequest,
  FallbackRestoreContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.fallbackPolicy.restoreTierGroups",
    FallbackRestoreContext
  >({
    client,
    method: "providers.fallbackPolicy.restoreTierGroups",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.restoreFallbackTierGroups(),
      // The SAME scope as the save and the reset - see
      // `fallbackPolicyWriteScope`. This one writes the get-cache in place
      // like the save does, so an unordered restore and save simply overwrite
      // each other's `policy` with whichever answer arrived second.
      scope: fallbackPolicyWriteScope(client.getActiveHostId()),
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      onSuccess: (data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        queryClient.setQueriesData<ProvidersFallbackPolicyGetResponse>(
          {
            queryKey: hostQueryKeys.methodScope(
              ctx.hostId,
              "providers.fallbackPolicy.get",
            ),
          },
          (previous) =>
            previous === undefined
              ? undefined
              : {
                  ...previous,
                  policy: data.policy,
                  storedPolicyUnreadable: false,
                },
        );
      },
    },
  });
}
