import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { withHostRpcErrorBoundary } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostClient,
  useHostDirectory,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import {
  hostClientUnavailableError,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface StopTerminalOwnerVariables {
  /** The host the session lives on - the resource row's `owner.hostId`. */
  readonly hostId: string;
  /**
   * The terminal session to stop. For a `terminal-agent` owner this is also
   * the agent id: `ResourceOwnerRef.ownerId` is the session id for both
   * terminal owner kinds.
   */
  readonly sessionId: string;
}

/**
 * The resource monitor's STOP for a terminal / terminal-agent owner row:
 * `terminal.kill` routed to the row's OWN host, resolved per call.
 *
 * It lives beside `useResourcesKill` rather than in `hooks/terminal/` on
 * purpose. Every hook in that directory takes its caller's client, because its
 * callers are Epic-scoped surfaces whose host is the tab's or the session's -
 * and a wrapper there resolving the app-wide directory would launder exactly
 * the read that rule bans. The resource monitor is app chrome with its own
 * host picker: it renders rows for whichever hosts its projection covers and
 * decides the target at click time, so it has no single bound client to take.
 * Pinning a transient client to the row's own `hostId`, per call, is what
 * `useResourcesKill` beside it already does - and a host switch mid-flight
 * cannot redirect it.
 *
 * ## Why a terminal owner is STOPPED and not killed
 *
 * Signalling a terminal-agent's process tree through `resources.kill` reaches
 * the PTY as an ordinary SIGTERM, and nothing on the host correlates that
 * signal with the person who asked for it: the session manager sees
 * `exitCode=143 reason=process-exit`, the inbox bridge reports the agent
 * "exited", and an orchestrator waiting on it is told its peer died without
 * replying - a verdict that then sticks until the agent is re-armed. Routing
 * the same gesture through `terminal.kill` lets the host record it as a user
 * stop: the sender is told the agent "was stopped by the user", the record is
 * stamped `sleeping`, and the next message resumes the same session.
 *
 * The visible verb follows: a terminal owner's row says Stop, for the same
 * reason a managed command's does.
 */
export function useStopTerminalOwner(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.kill">,
  HostRpcError,
  StopTerminalOwnerVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();
  const queryClient = useQueryClient();

  return useMutation(
    withHostMutationLifecycleBoundary("terminal.kill", {
      mutationKey: terminalMutationKeys.kill(),
      mutationFn: (variables) =>
        withHostRpcErrorBoundary("terminal.kill", () => {
          const entry = directory.findById(variables.hostId);
          const client: HostClient<HostRpcRegistry> | null =
            entry === null
              ? null
              : buildDialableHostClient(defaultClient, entry);
          if (client === null) {
            return Promise.reject(hostClientUnavailableError("terminal.kill"));
          }
          return client.request("terminal.kill", {
            sessionId: variables.sessionId,
          });
        }),
      onSuccess: (_data, variables) => {
        // The session list is what every other surface reads presence from,
        // and the row this stop came from lives on the `resources.subscribe`
        // stream, which reflects the processes leaving on its own. Scoped to
        // the one method for the reason `useTerminalKillFor` gives: the whole
        // host scope would also force-refetch the manual-refresh-only
        // cloud-tasks history.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            variables.hostId,
            "terminal.list",
          ),
        });
      },
      onError: (error) => toastFromHostError(error, "Failed to stop the agent"),
    }),
  );
}
