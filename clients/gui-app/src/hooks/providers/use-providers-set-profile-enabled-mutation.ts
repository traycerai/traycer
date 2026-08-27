import {
  useMutationState,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import {
  hostQueryKeys,
  providersListQueryKey,
  providersMutationKeys,
} from "@/lib/query-keys";

interface SetProfileEnabledContext {
  readonly hostId: string | null;
  readonly previousEnabled: boolean | undefined;
}

export function useProvidersSetProfileEnabledForClient(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setProfileEnabled">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setProfileEnabled">,
  SetProfileEnabledContext
> {
  const queryClient = useQueryClient();
  const hostId = client?.getActiveHostId() ?? null;
  return useHostMutation<
    HostRpcRegistry,
    "providers.setProfileEnabled",
    SetProfileEnabledContext
  >({
    client,
    method: "providers.setProfileEnabled",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.setProfileEnabled(hostId, providerId),
      onMutate: async (variables) => {
        const capturedHostId = client?.getActiveHostId() ?? null;
        if (capturedHostId === null) {
          return { hostId: null, previousEnabled: undefined };
        }
        const queryKey = providersListQueryKey(capturedHostId);
        await queryClient.cancelQueries({ queryKey, exact: true });
        const previous =
          queryClient.getQueryData<ProvidersListResponse>(queryKey);
        const previousEnabled = previous?.providers
          .find((provider) => provider.providerId === variables.providerId)
          ?.profiles.find(
            (profile) => profile.profileId === variables.profileId,
          )?.enabled;
        queryClient.setQueryData<ProvidersListResponse>(queryKey, (current) =>
          setProfileEnabled(current, variables, variables.enabled),
        );
        return { hostId: capturedHostId, previousEnabled };
      },
      onError: (error, variables, context) => {
        const previousEnabled = context?.previousEnabled;
        if (
          context?.hostId !== null &&
          context?.hostId !== undefined &&
          previousEnabled !== undefined
        ) {
          queryClient.setQueryData<ProvidersListResponse>(
            providersListQueryKey(context.hostId),
            (current) => setProfileEnabled(current, variables, previousEnabled),
          );
        }
        toastFromHostError(error, "Couldn't update profile availability.");
      },
      onSettled: async (_data, _error, _variables, context) => {
        if (context?.hostId === null || context?.hostId === undefined) return;
        await Promise.all(
          PROVIDER_INVALIDATIONS.map((method) =>
            queryClient.invalidateQueries({
              queryKey: hostQueryKeys.methodScope(context.hostId, method),
            }),
          ),
        );
      },
    },
  });
}

export function useProviderProfileEnablementPending(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string | null,
): (profileId: string | null) => boolean {
  const hostId = client?.getActiveHostId() ?? null;
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: providersMutationKeys.setProfileEnabled(hostId, providerId),
      status: "pending",
      exact: true,
    },
    select: (mutation) => mutation.state.variables,
  });
  const pendingProfileIds = new Set(
    pendingVariables.flatMap((variables) =>
      isSetProfileEnabledRequest(variables) ? [variables.profileId] : [],
    ),
  );
  return (profileId) => pendingProfileIds.has(profileId ?? "ambient");
}

function isSetProfileEnabledRequest(
  variables: unknown,
): variables is RequestOfMethod<
  HostRpcRegistry,
  "providers.setProfileEnabled"
> {
  return (
    typeof variables === "object" &&
    variables !== null &&
    "profileId" in variables &&
    typeof variables.profileId === "string"
  );
}

function setProfileEnabled(
  current: ProvidersListResponse | undefined,
  variables: RequestOfMethod<HostRpcRegistry, "providers.setProfileEnabled">,
  enabled: boolean,
): ProvidersListResponse | undefined {
  if (current === undefined) return current;
  return {
    ...current,
    providers: current.providers.map((provider) =>
      provider.providerId !== variables.providerId
        ? provider
        : {
            ...provider,
            profiles: provider.profiles.map((profile) =>
              profile.profileId === variables.profileId
                ? { ...profile, enabled }
                : profile,
            ),
          },
    ),
  };
}
