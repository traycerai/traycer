import { useEffect, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { WorktreeChangedStreamClient } from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { hostQueryKeys } from "@/lib/query-keys";

export function invalidateWorktreeChangedCaches(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    refetchType: "active",
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      hostId,
      "worktree.listByWorkspacePaths",
    ),
    refetchType: "active",
  });
}

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
        onChanged: () => invalidateWorktreeChangedCaches(queryClient, hostId),
        onConnectionStatus: () => undefined,
      },
    });
    return () => stream.close();
  }, [hostId, queryClient, support, wsStreamClient]);

  return null;
}
