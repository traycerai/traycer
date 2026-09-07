import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { hostQueryKeys, worktreeMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface RetrySetupMutationContext {
  readonly hostId: string | null;
}

/**
 * Retry on the explicit bound client. Capture `getActiveHostId()` in `onMutate` so binding invalidations survive an app-wide host swap. Null client is a rejecting no-op.
 */
export function useWorktreeRetrySetupFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.retrySetup">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.retrySetup">,
  RetrySetupMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "worktree.retrySetup">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "worktree.retrySetup">,
    RetrySetupMutationContext
  >(
    withHostMutationLifecycleBoundary("worktree.retrySetup", {
      mutationKey: worktreeMutationKeys.retrySetup(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("worktree.retrySetup", () => {
          if (client === null) {
            return Promise.reject<
              ResponseOfMethod<HostRpcRegistry, "worktree.retrySetup">
            >(hostClientUnavailableError("worktree.retrySetup"));
          }
          return client.request("worktree.retrySetup", variables);
        }),
      onMutate: () => {
        Analytics.getInstance().track(AnalyticsEvent.SetupScriptsRetryStarted, {
          source: "direct_ui",
        });
        return { hostId: client === null ? null : client.getActiveHostId() };
      },
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        for (const method of WORKTREE_BINDING_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(ctx.hostId, method),
          });
        }
      },
      onError: (error) => toastFromHostError(error, "Couldn't retry setup."),
    }),
  );
}
