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
 * One BOUNDED status read for an in-flight OAuth attempt.
 *
 * A mutation rather than a query even though it reads: the caller drives the
 * cadence from its own waiting panel and each tick must produce a fresh answer,
 * which is the opposite of what a cached, invalidation-driven query slot is
 * for. It also needs no long-poll budget - the host answers from its
 * pending-auth registry immediately, so the default response frame applies
 * (unlike `providers.awaitLogin`, which blocks on a child process).
 *
 * Errors are typed arms on a SUCCESSFUL response, so there is no `onError`
 * toast: `attempt_superseded` in particular is a normal, expected outcome
 * (a newer attempt owns the surface) and the caller stands down silently on it.
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
