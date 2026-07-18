import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WorktreeChangedStreamClient } from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  createWorktreeChangedInvalidationScheduler,
  WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
  WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

export function WorktreeChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("worktree.changed");
  const hostId = useReactiveActiveHostId();
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
    const stream = new WorktreeChangedStreamClient({
      wsStreamClient,
      callbacks: {
        onChanged: (scope) => scheduler.push(scope),
        onConnectionStatus: () => undefined,
      },
    });
    return () => {
      stream.close();
      scheduler.dispose();
    };
  }, [hostId, queryClient, support, wsStreamClient]);

  return null;
}
