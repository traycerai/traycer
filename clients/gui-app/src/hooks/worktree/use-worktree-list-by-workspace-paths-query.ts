import { keepPreviousData, type UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useWorktreeListByWorkspacePathsForClient(
  client: HostClient<HostRpcRegistry> | null,
  args: {
    readonly workspacePaths: ReadonlyArray<string>;
    readonly enabled: boolean;
  },
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.listByWorkspacePaths">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "worktree.listByWorkspacePaths">({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listByWorkspacePaths",
    // This summary-listing path never previews ref scripts; the per-ref read is a
    // separate point-read (see worktree-scripts-dialog). v1.1 requires the field.
    // `forceRefresh: false` (v1.2): a background read serves the host's
    // TTL-cached view; only an explicit user refresh forces a disk recompute.
    params: {
      workspacePaths: [...args.workspacePaths],
      scriptRefs: [],
      forceRefresh: false,
    },
    options: {
      enabled: args.enabled && args.workspacePaths.length > 0,
      // The path set is part of the query key, so adding/removing a folder
      // lands on a fresh cache entry. Retain the prior result while the new set
      // refetches so the surviving rows keep their resolved metadata instead of
      // every row flashing "Loading folder metadata…" on each edit.
      placeholderData: keepPreviousData,
    },
  });
}
