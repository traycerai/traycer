import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProvidersCancelModelProviderAuthResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { invalidateAfterModelProviderMutation } from "@/hooks/providers/model-provider-invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

export interface CancelModelProviderAuthVariables {
  readonly providerId: ProviderId;
  readonly modelProviderId: string;
  readonly attemptId: string;
}

interface CancelModelProviderAuthContext {
  readonly hostId: string | null;
}

/** Local cancel only. Invalidate only on cancelled false (credential already wrote). cancelled true must not refetch. */
export function useProvidersCancelModelProviderAuth(): UseMutationResult<
  ProvidersCancelModelProviderAuthResponse,
  HostRpcError,
  CancelModelProviderAuthVariables,
  CancelModelProviderAuthContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.cancelModelProviderAuth",
    CancelModelProviderAuthContext,
    CancelModelProviderAuthVariables
  >({
    client,
    method: "providers.cancelModelProviderAuth",
    mapVariables: (variables) => ({
      providerId: variables.providerId,
      context: {
        modelProviderId: variables.modelProviderId,
        attemptId: variables.attemptId,
      },
    }),
    options: {
      mutationKey: providersMutationKeys.cancelModelProviderAuth(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (data, variables, context) => {
        if (data.cancelled || data.result.kind !== "done") return;
        void invalidateAfterModelProviderMutation({
          queryClient,
          hostId: context.hostId,
          providerId: variables.providerId,
        });
      },
      // No `onError` toast.
    },
  });
}
