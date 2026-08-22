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
 * A session that stayed open at least this long before closing counts as
 * healthy, resetting the reopen lane's backoff even if it carried no events.
 * Mirrors the reconnect engine's rebuild-pacer healthy-lifetime constant.
 */
const HEALTHY_SESSION_RESET_MS = 30_000;

export function WorktreeChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("worktree.changed");
  // Both the rebuild key AND the identity the reopen lane and the query
  // invalidations below are scoped to - so it must come off the same
  // `StreamRuntimeBinding` as `wsStreamClient` (one binding, one answer),
  // never a separately-updating resolver like `useAddressableHostId`, which
  // can name a different machine mid-swap.
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
