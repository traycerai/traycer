import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WorktreeChangedStreamClient } from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";

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
    const stream = new WorktreeChangedStreamClient({
      wsStreamClient,
      callbacks: {
        onChanged: (scope) =>
          invalidateWorktreeChangedCaches(queryClient, hostId, scope),
        onConnectionStatus: () => undefined,
      },
    });
    return () => stream.close();
  }, [hostId, queryClient, support, wsStreamClient]);

  return null;
}
