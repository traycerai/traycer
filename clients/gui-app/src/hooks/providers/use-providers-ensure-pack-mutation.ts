import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

type EnsurePackMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.ensurePack">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.ensurePack">,
  EnsurePackMutationContext
>;

interface EnsurePackMutationContext {
  readonly hostId: string | null;
}

/**
 * The retry affordance behind a `downloading`/`error` provider row: asks the
 * host to get this provider's managed pack ready.
 *
 * Reaching the host through this method is what marks the request as
 * USER-INITIATED, which is the whole point - the host clears that pack's
 * exponential backoff, promotes it to the front of the install queue, and
 * takes the one arm permitted to quarantine an unverifiable version directory.
 * Automatic paths (boot convergence, turn-start resolution) deliberately do
 * none of those things. So this hook must only ever be called from a real user
 * gesture; wiring it into an effect or a poll would launder a background retry
 * into a human one.
 *
 * Non-blocking by contract: the response is the pack's state as of the kick,
 * not the finished install. Progress arrives through `providers.list`, which
 * already carries `managedInstallState` - hence the invalidation rather than a
 * `setQueryData`.
 *
 * `onError` is deliberately omitted. The failure the user cares about is the
 * INSTALL failing, and that surfaces durably on the row itself as the `error`
 * arm with its reason; a toast for a failed kick would be a second, noisier
 * report of the same thing.
 */
export function useProvidersEnsurePack(): EnsurePackMutationResult {
  return useProvidersEnsurePackForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersTouchLoginForClient`. */
export function useProvidersEnsurePackForClient(
  client: HostClient<HostRpcRegistry> | null,
): EnsurePackMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.ensurePack",
    EnsurePackMutationContext
  >({
    client,
    method: "providers.ensurePack",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.ensurePack(),
      // Host-swap race: capture the host at mutate time and invalidate THAT
      // host's list, never whichever host happens to be active when the
      // response lands.
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_result, _variables, context) => {
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
    },
  });
}
