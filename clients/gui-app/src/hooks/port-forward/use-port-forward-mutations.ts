import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import {
  hostClientUnavailableError,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, portForwardMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

interface PortForwardMutationContext {
  readonly hostId: string | null;
}

/**
 * Stops a forward on the host that OWNS it, through an explicit client (a
 * tab's, or Settings' scoped one) rather than the app-wide active host. The
 * host id is captured in `onMutate` so the listing invalidation lands on that
 * host's scope even if the app-wide host swaps mid-flight.
 *
 * On an `interrupted` forward this is what "Clear" sends: there is no separate
 * verb, because clearing the record IS stopping the forward.
 *
 * The chat's own rows need no invalidation - the host pushes the new set on
 * the chat stream - so only the host-level listing is refreshed.
 */
export function usePortForwardStopFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "portForward.stop">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "portForward.stop">,
  PortForwardMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "portForward.stop">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "portForward.stop">,
    PortForwardMutationContext
  >(
    withHostMutationLifecycleBoundary("portForward.stop", {
      mutationKey: portForwardMutationKeys.stop(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("portForward.stop", () => {
          if (client === null) {
            return Promise.reject<
              ResponseOfMethod<HostRpcRegistry, "portForward.stop">
            >(hostClientUnavailableError("portForward.stop"));
          }
          return client.request("portForward.stop", variables);
        }),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            ctx.hostId,
            "portForward.listForHost",
          ),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't stop the port forward."),
    }),
  );
}

/**
 * Cuts a lease this host HOLDS for another machine's forward: its listener (or
 * its reach to the target port) closes here, and the owning machine's forward
 * goes `interrupted`. The non-owning side's only control.
 */
export function usePortForwardCutLeaseFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "portForward.cutLease">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "portForward.cutLease">,
  PortForwardMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "portForward.cutLease">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "portForward.cutLease">,
    PortForwardMutationContext
  >(
    withHostMutationLifecycleBoundary("portForward.cutLease", {
      mutationKey: portForwardMutationKeys.cutLease(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("portForward.cutLease", () => {
          if (client === null) {
            return Promise.reject<
              ResponseOfMethod<HostRpcRegistry, "portForward.cutLease">
            >(hostClientUnavailableError("portForward.cutLease"));
          }
          return client.request("portForward.cutLease", variables);
        }),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            ctx.hostId,
            "portForward.listForHost",
          ),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't cut the port forward."),
    }),
  );
}
