import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfileAccentColor } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface RecolorProviderProfileRequest {
  readonly providerId: RequestOfMethod<
    HostRpcRegistry,
    "providers.setEnabled"
  >["providerId"];
  readonly profileId: string;
  readonly accentColor: ProviderProfileAccentColor;
}

type RecolorProviderProfileMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  RecolorProviderProfileRequest,
  { readonly hostId: string | null }
>;

export function useRecolorProviderProfile(): RecolorProviderProfileMutationResult {
  return useRecolorProviderProfileForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useRecolorProviderProfileForClient(
  client: HostClient<HostRpcRegistry> | null,
): RecolorProviderProfileMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setEnabled",
    { readonly hostId: string | null },
    RecolorProviderProfileRequest
  >({
    client,
    method: "providers.setEnabled",
    mapVariables: (variables: RecolorProviderProfileRequest) =>
      ({
        providerId: variables.providerId,
        enabled: true,
        profileAction: {
          type: "recolor",
          profileId: variables.profileId,
          accentColor: variables.accentColor,
        },
      }) satisfies RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
    options: {
      mutationKey: providersMutationKeys.recolorProfile(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't recolor profile."),
    },
  });
}
