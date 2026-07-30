import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostRpcError as HostRpcErrorCtor } from "@traycer-clients/shared/host-transport/host-messenger";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { agentMutationKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";

/**
 * Read-only cross-profile fork-admission preflight - the optional
 * (non-floor) `agent.tui.validateForkProfile` RPC (tech plan governing
 * mechanism 2). Callers MUST gate on
 * `useHostSupportsMethod(hostId, "agent.tui.validateForkProfile")` before
 * invoking this - an old host that lacks the method rejects the call with
 * `E_HOST_UNSUPPORTED` rather than silently degrading. Its negotiated
 * presence IS the capability signal; there is no separate flag.
 *
 * Advisory only: `agent.tui.prepareLaunch` re-runs the same guard
 * authoritatively at the top of its own resolver (TOCTOU-safe). No `onError`
 * toast here - this is consumed inline by the fork flow
 * (`use-create-tui-agent.ts`), which surfaces its own rejection messaging
 * rather than a generic host-error toast.
 */
export function useValidateTuiForkProfile(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">
> {
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">
  >(
    withHostMutationLifecycleBoundary("agent.tui.validateForkProfile", {
      mutationKey: agentMutationKeys.validateForkProfile(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("agent.tui.validateForkProfile", () => {
          if (client === null) {
            return Promise.reject(
              new HostRpcErrorCtor({
                code: "RPC_ERROR",
                message:
                  "Cannot validate a fork profile without a host client.",
                requestId: "client-preflight",
                method: "agent.tui.validateForkProfile",
                fatalDetails: null,
              }),
            );
          }
          return client.request("agent.tui.validateForkProfile", variables);
        }),
    }),
  );
}
