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
 * Retries worktree setup on an EXPLICIT host client rather than the app-wide
 * active host. The client must already be bound to its host (built via
 * `useHostClientFor` / `useTabHostClient`); its `getActiveHostId()` is
 * captured in `onMutate` so the post-success binding invalidations land on that
 * host's scope even if the app-wide host swaps mid-flight.
 *
 * A `null` client (directory not resolved / signed out) makes the mutation a
 * rejecting no-op - callers gate the affordance on a resolved client, matching
 * `useTerminalKillFor`'s behavior.
 *
 * Unlike `useTerminalKillFor` (one `terminal.list` scope), retry touches the
 * worktree binding caches, so it invalidates every method in
 * `WORKTREE_BINDING_INVALIDATIONS` on the captured host scope.
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
