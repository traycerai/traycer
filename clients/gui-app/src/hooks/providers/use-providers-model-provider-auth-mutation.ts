import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ModelProviderAuthAction } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderId,
  ProvidersModelProviderAuthResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { invalidateAfterModelProviderMutation } from "@/hooks/providers/model-provider-invalidations";
import { providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/** The actions that write the provider's CONFIG FILE rather than its auth store.
 * They settle differently from the rest: the host commits the block and rotates before it reports the credential step, so even a failed key leaves the catalog changed - which makes "invalidate only on `done`" wrong for exactly these two. */
function isCustomProviderWrite(action: ModelProviderAuthAction): boolean {
  return action.action === "createCustom" || action.action === "updateCustom";
}

export interface ModelProviderAuthVariables {
  readonly providerId: ProviderId;
  readonly action: ModelProviderAuthAction;
}

interface ModelProviderAuthContext {
  readonly hostId: string | null;
}

/**
 * `onError` is transport only. Credential outcomes are typed success arms the caller renders inline; do not toast those.
 */
export function useProvidersModelProviderAuth(): UseMutationResult<
  ProvidersModelProviderAuthResponse,
  HostRpcError,
  ModelProviderAuthVariables,
  ModelProviderAuthContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.modelProviderAuth",
    ModelProviderAuthContext,
    ModelProviderAuthVariables
  >({
    client,
    method: "providers.modelProviderAuth",
    mapVariables: (variables) => ({
      providerId: variables.providerId,
      action: variables.action,
    }),
    options: {
      mutationKey: providersMutationKeys.modelProviderAuth(),
      // Captured here, not read in `onSuccess`: a host swap mid-flight would
      // otherwise invalidate the NEW host's caches with the old host's result.
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (data, variables, context) => {
        // A config write retires caches on every arm. A pending OAuth poll has changed nothing; invalidating it would re-lease a managed server every tick.
        if (
          isCustomProviderWrite(variables.action) ||
          data.result.kind === "done"
        ) {
          void invalidateAfterModelProviderMutation({
            queryClient,
            hostId: context.hostId,
            providerId: variables.providerId,
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't reach the host for that sign-in."),
    },
  });
}
