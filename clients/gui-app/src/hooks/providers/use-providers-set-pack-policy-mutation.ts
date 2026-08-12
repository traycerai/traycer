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
import { toastFromHostError } from "@/lib/host-error-toast";

type SetPackPolicyMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setPackPolicy">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setPackPolicy">,
  SetPackPolicyMutationContext
>;

interface SetPackPolicyMutationContext {
  readonly hostId: string | null;
}

/**
 * Set per-pack auto-download policy. Echoes the durable value on success.
 * Policy write failures have no typed-refusal arm — toast a host error.
 */
export function useProvidersSetPackPolicy(): SetPackPolicyMutationResult {
  return useProvidersSetPackPolicyForClient(useHostClient());
}

export function useProvidersSetPackPolicyForClient(
  client: HostClient<HostRpcRegistry> | null,
): SetPackPolicyMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setPackPolicy",
    SetPackPolicyMutationContext
  >({
    client,
    method: "providers.setPackPolicy",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.setPackPolicy(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_result, _variables, context) => {
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't update auto-download.");
      },
    },
  });
}
