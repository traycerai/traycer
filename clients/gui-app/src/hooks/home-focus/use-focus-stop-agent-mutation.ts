import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import {
  HostRpcError,
  withHostRpcErrorBoundary,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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
import { toastFromHostError } from "@/lib/host-error-toast";
import { agentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

/** What `onMutate` captured at SEND time. The host a response is filed against
 * must be the one the request went out on, never the one the client happens to
 * address when it lands. */
interface FocusStopAgentContext {
  readonly hostId: string | null;
}

export interface FocusStopAgentInput {
  /** The agent's own host, or `null` to send on whichever host this window is
   * addressing. */
  readonly hostId: string | null;
  readonly epicId: string;
  readonly agentId: string;
  readonly cascade: boolean;
}

/**
 * `agent.stop`, aimed at the AGENT's host rather than at whichever host the
 * window happens to be addressing.
 *
 * `useAgentStop` is the app's ordinary stop and rides `useHostScopedMutation`,
 * which resolves one client for the whole hook. That is right for a surface
 * inside a task - everything on it belongs to one host - and wrong here: Home
 * lists every task on the account, so two rows on the same page can name
 * different machines, and a hook-level client would send one of them to a host
 * that has never heard of that agent.
 *
 * So the client is resolved per call from the host directory, the same shape
 * `useManagedCommandStop` uses for exactly the same reason. `null` follows the
 * window's own client, which is what an agent with no recorded host gets.
 *
 * On success the host's `agent.list` cache is dropped - a stop changes which
 * agents are running - scoped to the host captured in `onMutate`, so a host
 * switch mid-flight cannot invalidate the wrong machine's cache.
 */
export function useFocusStopAgent(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.stop">,
  HostRpcError,
  FocusStopAgentInput,
  // `| undefined` because TanStack types the context as absent until `onMutate`
  // has run - a callback firing before it (an `onError` from the boundary
  // itself) legitimately has none.
  FocusStopAgentContext | undefined
> {
  const followingClient = useHostClient();
  const directory = useHostDirectory();
  const queryClient = useQueryClient();

  return useMutation(
    withHostMutationLifecycleBoundary("agent.stop", {
      mutationKey: agentMutationKeys.stop(),
      mutationFn: (variables: FocusStopAgentInput) =>
        withHostRpcErrorBoundary("agent.stop", () => {
          // `null` follows this window's own client - that is what an agent
          // with no recorded host gets, and what the row's `stoppable` already
          // promised.
          const client =
            variables.hostId === null
              ? followingClient
              : transientClientForEntry(
                  followingClient,
                  directory.findById(variables.hostId),
                );
          if (client === null) {
            return Promise.reject(hostClientUnavailableError("agent.stop"));
          }
          return client.request("agent.stop", {
            epicId: variables.epicId,
            agentId: variables.agentId,
            cascade: variables.cascade,
          });
        }),
      // Read at SEND time, not at settle time. For a `null`-host agent the
      // request goes out on whatever host the window addresses THEN, and the
      // user can activate another host in Settings while it is in flight -
      // which would otherwise drop `agent.list` for the new host and leave the
      // one that actually stopped the agent listing it as running. This is the
      // host-swap rule in gui-app AGENTS.md, and what `useHostScopedMutation`
      // does for every other host mutation in the app.
      onMutate: (variables: FocusStopAgentInput): FocusStopAgentContext => ({
        hostId: variables.hostId ?? followingClient.getActiveHostId() ?? null,
      }),
      onSuccess: (
        _data,
        _variables: FocusStopAgentInput,
        context: FocusStopAgentContext | undefined,
      ) => {
        const hostId = context?.hostId ?? null;
        if (hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, "agent.list"),
        });
      },
      onError: (error: HostRpcError) =>
        toastFromHostError(error, "Couldn't stop agent."),
    }),
  );
}

/**
 * A named host resolves to a transient client dialed at that directory row.
 * Both "no such host in the directory" and "that host is not reachable"
 * collapse to `null`, because the caller answers them the same way - the
 * `hostClientUnavailableError` rejection.
 */
function transientClientForEntry(
  defaultClient: HostClient<HostRpcRegistry>,
  entry: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  return entry === null ? null : buildDialableHostClient(defaultClient, entry);
}
