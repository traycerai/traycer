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

/**
 * Abandons an in-flight OAuth attempt. Best-effort and LOCAL: upstream exposes
 * no OAuth-cancel endpoint, so this discards the host's pending attempt and
 * releases its server lease. It never claims to have revoked anything at the
 * provider.
 *
 * `cancelled: false` is not a failure - it means the attempt had already
 * settled, expired or been superseded, and `result` describes what it settled
 * as.
 *
 * That distinction is exactly what decides whether anything is invalidated. A
 * successful teardown reports `{ cancelled: true, result: done }`, where `done`
 * describes the CANCEL and not a credential - nothing changed upstream, so
 * refetching would re-lease a managed server the user just asked to be let go
 * of. Only the `cancelled: false` race - the browser callback landing while the
 * click was in flight - actually wrote a credential.
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
      onSuccess: (data, variables, context) => {
        if (data.cancelled || data.result.kind !== "done") return;
        void invalidateAfterModelProviderMutation({
          queryClient,
          hostId: context.hostId,
          providerId: variables.providerId,
        });
      },
      // No `onError` toast. The only consumer renders this failure inline, in
      // the waiting panel the attempt still owns, and a toast would report the
      // same failure a second time somewhere the attempt is not - the
      // inline-error exemption the gui-app guidelines carve out.
    },
  });
}
