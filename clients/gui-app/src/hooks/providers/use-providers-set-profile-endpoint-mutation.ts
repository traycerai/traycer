import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileCredentialKind,
  ProvidersGetProfileConfigResponse,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { invalidateProviderFamily } from "@/hooks/providers/invalidations";

/** D07: the credential's three-armed update - "leave it alone" is expressible
 *  without a magic empty string, matching `providersSetProfileConfigRequestSchema`'s
 *  `credentialUpdate` (this form never offers "clear" - D07/D25 name no
 *  reveal-or-clear affordance for a stored key, only "type to replace"). */
export type SetProfileEndpointCredentialUpdate =
  | { readonly kind: "unchanged" }
  | { readonly kind: "set"; readonly value: string };

export interface SetProfileEndpointVariables {
  readonly providerId: ProviderId;
  /** `null` addresses the Default account's row (D05). */
  readonly profileId: string | null;
  readonly baseUrl: string | null;
  readonly credentialKind: ProfileCredentialKind;
  readonly defaultModel: string | null;
  readonly credentialUpdate: SetProfileEndpointCredentialUpdate;
}

interface ProfileEndpointMutateContext {
  readonly hostId: string | null;
}

function profileConfigQueryKey(
  hostId: string | null,
  providerId: ProviderId,
  profileId: string | null,
) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.getProfileConfig">(
    hostId,
    "providers.getProfileConfig",
    { providerId, profileId },
  );
}

/**
 * The Account tab's endpoint form save (D06/D12). Same read-modify-write
 * shape as `useProvidersSetProfileEnvOverride`: `providers.setProfileConfig`
 * takes the WHOLE config, never a sparse patch and carries no revision token
 * (D01/D15/D16), so this reads the current config fresh and writes it back
 * with only `endpoint` changed.
 */
export function useProvidersSetProfileEndpoint(): UseMutationResult<
  ProvidersGetProfileConfigResponse,
  HostRpcError,
  SetProfileEndpointVariables,
  ProfileEndpointMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    ProvidersGetProfileConfigResponse,
    HostRpcError,
    SetProfileEndpointVariables,
    ProfileEndpointMutateContext
  >({
    mutationKey: providersMutationKeys.setProfileEndpoint(),
    mutationFn: async (variables) => {
      const current = await client.request("providers.getProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
      });
      return client.request("providers.setProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
        config: {
          ...current.config,
          endpoint: {
            baseUrl: variables.baseUrl,
            credentialKind: variables.credentialKind,
            credentialConfigured:
              current.config.endpoint?.credentialConfigured ?? false,
            defaultModel: variables.defaultModel,
            lastTest: current.config.endpoint?.lastTest ?? null,
          },
        },
        credentialUpdate: variables.credentialUpdate,
      });
    },
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    onSuccess: (data, variables, ctx) => {
      if (ctx.hostId === null) return;
      queryClient.setQueryData(
        profileConfigQueryKey(
          ctx.hostId,
          variables.providerId,
          variables.profileId,
        ),
        data,
      );
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't save endpoint settings."),
    onSettled: (_data, _error, _variables, ctx) =>
      invalidateProviderFamily(queryClient, ctx?.hostId ?? null),
  });
}
