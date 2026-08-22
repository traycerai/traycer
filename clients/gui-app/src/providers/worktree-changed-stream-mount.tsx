import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WorktreeChangedStreamClient } from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  createWorktreeChangedInvalidationScheduler,
  WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
  WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

export function WorktreeChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("worktree.changed");
  const hostId = useAddressableHostId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    // The host's freshness sweep pushes one event per re-derived row; the
    // scheduler collapses each wave into a single invalidation flush so the
    // base-list/workspace-paths refetch pair runs once per burst, not once
    // per row (providers-list storm RCA, live CDP audit).
    const scheduler = createWorktreeChangedInvalidationScheduler({
      onFlush: (scopes) =>
        invalidateWorktreeChangedCaches(queryClient, hostId, scopes),
      debounceMs: WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
      maxWaitMs: WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
    });
    // A terminal close disposes the transport session, and a disposed session
    // ignores `requestReconnect` / wake-time `forceReconnect` - this mount
    // used to swallow connection status, so one terminal close (e.g. the
    // bounded UNAUTHORIZED give-up) left worktree push-invalidation dead
    // until reload. The reopen lane rebuilds the client on the host's shared
    // backoff instead.
    // Narrowed capture: the guard above does not narrow `wsStreamClient`
    // inside the nested `openClient` function declaration.
    const streamClient = wsStreamClient;
    const hostConnection = acquireHostConnection(hostId);
    let disposed = false;
    let currentClient: WorktreeChangedStreamClient | null = null;
    const reopenScheduler = hostConnection.reconnect.openReopenLane(() => {
      const client = currentClient;
      currentClient = null;
      client?.close();
      openClient();
    }, isReopenableHostStreamClose);

    function openClient(): void {
      if (disposed) return;
      let client: WorktreeChangedStreamClient | null = null;
      client = new WorktreeChangedStreamClient({
        wsStreamClient: streamClient,
        callbacks: {
          onChanged: (scope) => {
            if (currentClient !== client) return;
            // A delivered event is the usable-session proof for this stream
            // (it has no initial state frame to reset on).
            reopenScheduler.resetBackoff();
            scheduler.push(scope);
          },
          onConnectionStatus: (status, reason) => {
            if (currentClient !== client) return;
            if (status === "closed") {
              reopenScheduler.scheduleAfterClose(reason);
            }
          },
        },
      });
      currentClient = client;
    }

    openClient();
    return () => {
      disposed = true;
      reopenScheduler.dispose();
      const client = currentClient;
      currentClient = null;
      client?.close();
      scheduler.dispose();
      hostConnection.release();
    };
  }, [hostId, queryClient, support, wsStreamClient]);

  return null;
}
