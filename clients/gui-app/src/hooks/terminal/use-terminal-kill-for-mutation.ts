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
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface KillTerminalMutationContext {
  readonly hostId: string | null;
}

/**
 * Kills a terminal session on an EXPLICIT host client rather than the
 * app-wide active host. The client must already be bound to its host (built
 * via `useHostClientFor` / `useTabHostClient`); its `getActiveHostId()` is
 * captured in `onMutate` so the post-success `terminal.list` invalidation lands
 * on that host's scope even if the app-wide host swaps mid-flight.
 *
 * A `null` client (directory not resolved / signed out) makes the mutation a
 * rejecting no-op - callers gate the affordance on a resolved client + a live
 * session, matching `useHostQuery`'s null-client behavior.
 *
 * `useTerminalKill` is the default-host convenience wrapper over this hook.
 */
export function useTerminalKillFor(
  client: HostClient<HostRpcRegistry> | null,
  errorMessage: string,
  trackUserIntent: boolean,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.kill">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.kill">,
  KillTerminalMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "terminal.kill">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "terminal.kill">,
    KillTerminalMutationContext
  >(
    withHostMutationLifecycleBoundary("terminal.kill", {
      mutationKey: terminalMutationKeys.kill(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("terminal.kill", () => {
          if (client === null) {
            return Promise.reject<
              ResponseOfMethod<HostRpcRegistry, "terminal.kill">
            >(hostClientUnavailableError("terminal.kill"));
          }
          return client.request("terminal.kill", variables);
        }),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (_data, _variables, ctx) => {
        if (trackUserIntent) {
          Analytics.getInstance().track(AnalyticsEvent.TerminalKilled, {
            kind: "shell",
          });
        }
        if (ctx.hostId === null) return;
        // Only the terminal-session list changed; invalidating the whole host
        // scope would also force-refetch the manual-refresh-only cloud-tasks
        // history.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(ctx.hostId, "terminal.list"),
        });
      },
      onError: (error) => toastFromHostError(error, errorMessage),
    }),
  );
}
