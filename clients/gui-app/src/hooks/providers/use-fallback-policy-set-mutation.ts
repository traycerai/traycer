import {
  useQueryClient,
  type MutationScope,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyGetResponse,
  ProvidersFallbackPolicySetRequest,
  ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

interface FallbackPolicySaveContext {
  readonly hostId: string | null;
}

/**
 * The ONE queue the three fallback-policy writes share - `set`,
 * `restoreTierGroups` and `reset` - keyed by host.
 *
 * ## The defect it closes
 *
 * All three write the same policy row, and two of them fold the response into
 * the `providers.fallbackPolicy.get` cache with `setQueriesData`. Nothing
 * ordered them. `HostRequestCoordinator.keyFor` is `JSON.stringify([hostId,
 * userId, method, stableWireJson(params)])`, so the PARAMS are part of the
 * queue key: two saves carrying two different policies sit in two different
 * FIFO queues and race, and three different methods are three keys again. The
 * cached policy therefore became whichever response LANDED last rather than
 * whichever write the user asked for last - and on the `.set` / `.reset` pair
 * the divergence outlives the render, because `reset` invalidates while `set`
 * writes in place.
 *
 * `host-method-policy-table.ts` says the same thing from the other side, on
 * `providers.fallbackPolicy.set`: `fifo` buys LANDING, never order, and the
 * ordering "has to come from a shared `MutationScope` on that hook, or from a
 * host-side revision check; this table cannot supply it". This is that scope.
 *
 * ## Why per HOST, and not per payload
 *
 * Per-payload granularity is exactly the broken key above - it is what
 * `HostRequestCoordinator` already does, and what puts two saves in two
 * queues. The policy is one row per host, so the host is the resource these
 * writes contend for and the right thing to serialize on.
 *
 * `null` is the host this surface could not resolve yet, and it gets its own
 * bucket rather than being folded into a named host's queue: two writes on an
 * unresolved client are still contending with each other, and a write that
 * later resolves to host A must not be ordered behind one aimed at nothing.
 * The three hooks read the id from the SAME `useHostClient()` result in the
 * same render, so they always agree with one another about which bucket they
 * are in - which is the only agreement the scope needs. A host that moves
 * under the panel moves all three together, and each response is still filed
 * against the `hostId` its own `onMutate` captured.
 *
 * ## One thing to know before mocking this module
 *
 * The reset and restore hooks IMPORT this function, so a suite that stubs
 * `use-fallback-policy-set-mutation` with a bare `vi.mock` factory and leaves
 * either sibling real gets `fallbackPolicyWriteScope is not a function` thrown
 * from inside the sibling - a fixture gap wearing a production stack trace.
 * The four `fallback-settings-panel*` suites all stub the three together, so
 * none of them is exposed today; use `importOriginal` (or stub all three) if
 * that changes.
 */
export function fallbackPolicyWriteScope(hostId: string | null): MutationScope {
  return { id: `providers.fallbackPolicy:${hostId ?? "unresolved-host"}` };
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
