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

export interface RenameProviderProfileRequest {
  readonly providerId: RequestOfMethod<
    HostRpcRegistry,
    "providers.setEnabled"
  >["providerId"];
  readonly profileId: string;
  readonly label: string;
}

type RenameProviderProfileMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  RenameProviderProfileRequest,
  { readonly hostId: string | null }
>;

export function useRenameProviderProfile(): RenameProviderProfileMutationResult {
  return useRenameProviderProfileForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useRenameProviderProfileForClient(
  client: HostClient<HostRpcRegistry> | null,
): RenameProviderProfileMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setEnabled",
    { readonly hostId: string | null },
    RenameProviderProfileRequest
  >({
    client,
    method: "providers.setEnabled",
    mapVariables: (variables: RenameProviderProfileRequest) =>
      ({
        providerId: variables.providerId,
        enabled: true,
        profileAction: {
          type: "rename",
          profileId: variables.profileId,
          label: variables.label,
        },
      }) satisfies RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
    options: {
      mutationKey: providersMutationKeys.renameProfile(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) => toastFromHostError(error, "Couldn't rename profile."),
    },
  });
}
