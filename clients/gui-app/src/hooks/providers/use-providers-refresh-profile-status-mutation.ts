import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import {
  hostQueryKeys,
  providersListQueryKey,
  providersMutationKeys,
} from "@/lib/query-keys";
import {
  buildProviderRateLimitEnvelopeFromSnapshot,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

interface RefreshProfileStatusContext {
  readonly hostId: string | null;
}

export function useProvidersRefreshProfileStatusForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.refreshProfileStatus">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.refreshProfileStatus">,
  RefreshProfileStatusContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.refreshProfileStatus",
    RefreshProfileStatusContext
  >({
    client,
    method: "providers.refreshProfileStatus",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.refreshProfileStatus(
        client?.getActiveHostId() ?? null,
      ),
      onMutate: () => ({
        hostId: client?.getActiveHostId() ?? null,
      }),
      onSuccess: async (data, variables, context) => {
        if (context.hostId === null) return;
        const rateLimitKey = hostQueryKeys.method<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(context.hostId, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId: variables.providerId,
          profileId:
            variables.profileId === "ambient" ? null : variables.profileId,
        });
        await queryClient.cancelQueries({
          queryKey: rateLimitKey,
          exact: true,
        });
        queryClient.setQueryData<ProviderRateLimitEnvelope>(
          rateLimitKey,
          (previous) =>
            buildProviderRateLimitEnvelopeFromSnapshot(
              previous,
              data.providerRateLimits,
              Date.now(),
            ),
        );
        await queryClient.invalidateQueries({
          queryKey: providersListQueryKey(context.hostId),
          exact: true,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh this profile."),
    },
  });
}
