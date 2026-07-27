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
import { toastFromHostErrorWithDetail } from "@/lib/host-error-toast";

interface StartTerminalSessionMutationContext {
  readonly hostId: string | null;
}

/**
 * Prepares a terminal-agent launch via the host-side adapter. New agents
 * pass `harnessSessionId: null`; reopened agents pass their persisted id
 * back so the adapter can rebuild any dynamic launch state needed for the
 * same logical session.
 */
export function useAgentStartTerminalSession(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch">,
  StartTerminalSessionMutationContext
> {
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch">,
    StartTerminalSessionMutationContext
  >(
    withHostMutationLifecycleBoundary("agent.tui.prepareLaunch", {
      mutationKey: agentMutationKeys.startTerminalSession(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("agent.tui.prepareLaunch", () => {
          if (client === null) {
            return Promise.reject(
              new HostRpcErrorCtor({
                code: "RPC_ERROR",
                message: "Cannot prepare terminal agent without a host client.",
                requestId: "client-preflight",
                method: "agent.tui.prepareLaunch",
                fatalDetails: null,
              }),
            );
          }
          return client.request("agent.tui.prepareLaunch", variables);
        }),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onError: (error) => {
        toastFromHostErrorWithDetail(
          error,
          "Couldn't start terminal agent session.",
        );
      },
    }),
  );
}
