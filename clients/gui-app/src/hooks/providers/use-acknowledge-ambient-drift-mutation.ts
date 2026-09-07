import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

export interface AcknowledgeAmbientDriftRequest {
  readonly providerId: ProviderId;
}

type AcknowledgeAmbientDriftMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  AcknowledgeAmbientDriftRequest,
  { readonly hostId: string | null }
>;

export function useAcknowledgeAmbientDrift(): AcknowledgeAmbientDriftMutationResult {
  return useAcknowledgeAmbientDriftForClient(useHostClient());
}

/**
 * No `onError`: an older host rejects unknown `profileAction` client-side. That capability gap must stay silent.
 */
export function useAcknowledgeAmbientDriftForClient(
  client: HostClient<HostRpcRegistry> | null,
): AcknowledgeAmbientDriftMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setEnabled",
    { readonly hostId: string | null },
    AcknowledgeAmbientDriftRequest
  >({
    client,
    method: "providers.setEnabled",
    mapVariables: (variables: AcknowledgeAmbientDriftRequest) =>
      ({
        providerId: variables.providerId,
        enabled: true,
        profileAction: { type: "acknowledgeAmbientDrift" },
      }) satisfies RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
    options: {
      mutationKey: providersMutationKeys.acknowledgeAmbientDrift(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
    },
  });
}
