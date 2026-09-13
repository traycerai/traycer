import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyGetResponse,
  ProvidersFallbackPolicySetRequest,
  ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  fallbackPolicyWriteScope,
  hostQueryKeys,
  providersMutationKeys,
} from "@/lib/query-keys";

interface FallbackPolicySaveContext {
  readonly hostId: string | null;
}

/**
 * Saves the fallback policy on the SURFACE's host.
 *
 * **No `onError` toast, deliberately.** This is an inline-error surface: a
 * rejected save reverts the control it came from and prints the host's reason
 * under that control, because a toast cannot say WHICH of a dozen settings on
 * the page was refused, and by the time it is read the reverted control looks
 * like it was never touched. The caller awaits this and dispatches its own
 * `save-failed`.
 *
 * The read query is updated in place rather than invalidated: a refetch would
 * race the user's next keystroke, and the response already carries the
 * authoritative policy.
 */
export function useFallbackPolicySetMutation(): UseMutationResult<
  ProvidersFallbackPolicySetResponse,
  HostRpcError,
  ProvidersFallbackPolicySetRequest,
  FallbackPolicySaveContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.fallbackPolicy.set",
    FallbackPolicySaveContext
  >({
    client,
    method: "providers.fallbackPolicy.set",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.setFallbackPolicy(),
      // Shared with the restore and reset hooks beside this one - see
      // `fallbackPolicyWriteScope`. Without it two rapid saves race and the
      // `setQueriesData` below writes whichever response LANDED last.
      scope: fallbackPolicyWriteScope(client.getActiveHostId()),
      // Captured before dispatch: the host can change under a slow save, and
      // writing the result into the new host's cache slot would show one
      // machine's policy under another's name.
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
                  // A save that succeeded wrote this user's row, so whatever
                  // was unreadable before is not unreadable now - `set` is the
                  // repair path the host keeps strict precisely so this holds.
                  storedPolicyUnreadable: false,
                },
        );
      },
    },
  });
}
