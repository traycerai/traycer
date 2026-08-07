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
import { toastFromHostError } from "@/lib/host-error-toast";

export interface CancelModelProviderAuthVariables {
  readonly providerId: ProviderId;
  readonly modelProviderId: string;
  readonly attemptId: string;
}

interface CancelModelProviderAuthContext {
  readonly hostId: string | null;
}

/**
 * Abandons an in-flight OAuth attempt. Best-effort and LOCAL: upstream exposes
 * no OAuth-cancel endpoint, so this discards the host's pending attempt and
 * releases its server lease. It never claims to have revoked anything at the
 * provider.
 *
 * `cancelled: false` is not a failure - it means the attempt had already
 * settled, expired or been superseded, and `result` describes what it settled
 * as. That is why a `done` result still invalidates: the race where the user
 * hits Cancel just as the browser callback lands is real, and the credential is
 * written either way.
 */
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
      onSuccess: (data, _variables, context) => {
        if (data.result.kind !== "done") return;
        invalidateAfterModelProviderMutation({
          queryClient,
          hostId: context.hostId,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't cancel the sign-in."),
    },
  });
}
