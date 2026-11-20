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

export interface SignOutProviderProfileRequest {
  readonly providerId: RequestOfMethod<
    HostRpcRegistry,
    "providers.signOutProfile"
  >["providerId"];
  readonly profileId: string;
}

type SignOutProviderProfileMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.signOutProfile">,
  HostRpcError,
  SignOutProviderProfileRequest,
  { readonly hostId: string | null }
>;

export function useSignOutProviderProfile(): SignOutProviderProfileMutationResult {
  return useSignOutProviderProfileForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useSignOutProviderProfileForClient(
  client: HostClient<HostRpcRegistry> | null,
): SignOutProviderProfileMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.signOutProfile",
    { readonly hostId: string | null },
    SignOutProviderProfileRequest
  >({
    client,
    method: "providers.signOutProfile",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.signOutProfile(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) => toastFromHostError(error, "Couldn't sign out."),
    },
  });
}
