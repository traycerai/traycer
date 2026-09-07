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

/** User-gesture only: never wire this into an effect or poll. No onError toast; install failure lives on the row. */
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
