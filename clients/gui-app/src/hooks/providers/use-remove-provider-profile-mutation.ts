import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface RemoveProviderProfileRequest {
  readonly providerId: RequestOfMethod<
    HostRpcRegistry,
    "providers.setEnabled"
  >["providerId"];
  readonly profileId: string;
}

type RemoveProviderProfileMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  RemoveProviderProfileRequest,
  { readonly hostId: string | null }
>;

export function useRemoveProviderProfile(): RemoveProviderProfileMutationResult {
  return useRemoveProviderProfileForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useRemoveProviderProfileForClient(
  client: HostClient<HostRpcRegistry> | null,
): RemoveProviderProfileMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setEnabled",
    { readonly hostId: string | null },
    RemoveProviderProfileRequest
  >({
    client,
    method: "providers.setEnabled",
    mapVariables: (variables: RemoveProviderProfileRequest) =>
      ({
        providerId: variables.providerId,
        enabled: true,
        native: null,
        profileAction: {
          type: "remove",
          profileId: variables.profileId,
        },
      }) satisfies RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
    options: {
      mutationKey: providersMutationKeys.removeProfile(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) => toastFromHostError(error, "Couldn't remove profile."),
    },
  });
}
