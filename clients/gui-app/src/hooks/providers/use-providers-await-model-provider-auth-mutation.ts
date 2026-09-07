import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProvidersAwaitModelProviderAuthResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { invalidateAfterModelProviderMutation } from "@/hooks/providers/model-provider-invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

export interface AwaitModelProviderAuthVariables {
  readonly providerId: ProviderId;
  readonly modelProviderId: string;
  readonly attemptId: string;
}

interface AwaitModelProviderAuthContext {
  readonly hostId: string | null;
}

/**
 * Bounded status read as a mutation so each tick is fresh. Typed errors ride a successful response; no `onError` toast (`attempt_superseded` is expected).
 */
export function useProvidersAwaitModelProviderAuth(): UseMutationResult<
  ProvidersAwaitModelProviderAuthResponse,
  HostRpcError,
  AwaitModelProviderAuthVariables,
  AwaitModelProviderAuthContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.awaitModelProviderAuth",
    AwaitModelProviderAuthContext,
    AwaitModelProviderAuthVariables
  >({
    client,
    method: "providers.awaitModelProviderAuth",
    mapVariables: (variables) => ({
      providerId: variables.providerId,
      context: {
        modelProviderId: variables.modelProviderId,
        attemptId: variables.attemptId,
      },
    }),
    options: {
      mutationKey: providersMutationKeys.awaitModelProviderAuth(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (data, variables, context) => {
        if (data.result.kind !== "done") return;
        void invalidateAfterModelProviderMutation({
          queryClient,
          hostId: context.hostId,
          providerId: variables.providerId,
        });
      },
    },
  });
}
