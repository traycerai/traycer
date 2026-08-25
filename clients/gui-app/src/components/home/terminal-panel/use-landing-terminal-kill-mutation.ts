import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  useHostClient,
  useHostDirectory,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

export interface LandingTerminalKillVariables {
  readonly hostId: string;
  readonly sessionId: string;
}

/**
 * Host-routed kill mutation used by the panel's durable tombstone lifecycle.
 * The tab's bound host is resolved at mutation time; it never falls through to
 * a newly selected app-default host.
 */
export function useLandingTerminalKill(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.kill">,
  HostRpcError,
  LandingTerminalKillVariables
> {
  const queryClient = useQueryClient();
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary("terminal.kill", {
      mutationKey: terminalMutationKeys.kill(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("terminal.kill", () => {
          const client = clientForLandingTerminal(
            defaultClient,
            directory.findById(variables.hostId),
          );
          if (client === null) {
            return Promise.reject(hostClientUnavailableError("terminal.kill"));
          }
          return client.request("terminal.kill", {
            sessionId: variables.sessionId,
          });
        }),
      onSuccess: (response, variables) => {
        // An acknowledgement is the durable boundary: only now can a tombstone
        // be cleared without reopening adoption to a still-running PTY.
        //
        // With one exception. `killed: false` is the host saying the session was
        // "already missing, or past its post-exit grace" - but for a session
        // whose `terminal.plain.create` had not settled when it was closed, it
        // equally means NOT CREATED YET, and the create still lands under this
        // exact id because the client is the one that chose it. Clearing there
        // is how the tombstone gets lost in front of the terminal it was written
        // to kill. Left outstanding, the drain retries under its own backoff and
        // the next attempt - after the create has landed - answers `true`.
        //
        // The reprieve is a DELAY, not a reprieve without end. Nothing here can
        // observe the create failing: the tile that dispatched it is gone, and
        // its lifecycle hook drops the settlement on unmount, so `pendingCreate`
        // would stay true forever for a create that rejected or for a terminal
        // that landed and exited first. The recovery bridge owns the bound
        // (`PENDING_CREATE_KILL_ANSWER_BUDGET`) and retires the record once the
        // host has answered "no such session" for the whole attempt ladder.
        const stillPendingCreate = useLandingTerminalStore
          .getState()
          .pendingKills.some(
            (pending) =>
              pending.hostId === variables.hostId &&
              pending.sessionId === variables.sessionId &&
              pending.pendingCreate,
          );
        if (!(!response.killed && stillPendingCreate)) {
          useLandingTerminalStore
            .getState()
            .clearPendingKill(variables.hostId, variables.sessionId);
        }
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            variables.hostId,
            "terminal.list",
          ),
        });
      },
    }),
  );
}

function clientForLandingTerminal(
  defaultClient: HostClient<HostRpcRegistry>,
  entry: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  if (entry === null) return null;
  // The app-default client resolves its endpoint on every retry. Always use a
  // transient client pinned to the tab host, even when that host is selected,
  // so a host switch during backoff can never redirect a destructive RPC.
  return buildTransientHostClient(defaultClient, entry);
}
