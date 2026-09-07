import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WorktreeChangedStreamClient } from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  createWorktreeChangedInvalidationScheduler,
  WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
  WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Open this long before close resets reopen backoff even with no events.
 */
const HEALTHY_SESSION_RESET_MS = 30_000;

export function WorktreeChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("worktree.changed");
  // Rebuild key and reopen/invalidation identity from the same binding as
  // wsStreamClient. useAddressableHostId can name a different machine mid-swap.
  const hostId = useStreamHostId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    // Collapse a freshness-sweep wave into one invalidation so refetch runs
    // once per burst, not once per row.
    const scheduler = createWorktreeChangedInvalidationScheduler({
      onFlush: (scopes) =>
        invalidateWorktreeChangedCaches(queryClient, hostId, scopes),
      debounceMs: WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
      maxWaitMs: WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
    });
    // Terminal close disposes the session; requestReconnect is ignored. Reopen
    // on the host's shared backoff. Capture wsStreamClient; the guard does not narrow inside openClient.
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
      let openedAtMs = 0;
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
            if (status === "open") {
              openedAtMs = Date.now();
              return;
            }
            if (status === "closed") {
              // Events are the only frame this stream carries; a healthy but
              // quiet session must still reset the lane, or the backoff
              // ratchets one-way across the client's lifetime.
              if (
                openedAtMs !== 0 &&
                Date.now() - openedAtMs >= HEALTHY_SESSION_RESET_MS
              ) {
                reopenScheduler.resetBackoff();
              }
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
