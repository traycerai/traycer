import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

/**
 * The one place this request's shape is written. Exported so a forced-refresh
 * cache write elsewhere (the owner hover card) can build the SAME params this
 * query uses instead of hand-copying the literal - a hand-copy hashes equal
 * today but silently forks the moment either side changes.
 */
export function worktreeListByWorkspacePathsParams(
  workspacePaths: ReadonlyArray<string>,
): RequestOfMethod<HostRpcRegistry, "worktree.listByWorkspacePaths"> {
  return {
    workspacePaths: [...workspacePaths],
    scriptRefs: [],
    forceRefresh: false,
  };
}

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
  // Host id is part of the query key. Retain previous data across path-set
  // edits on the SAME host, but never across a host switch — the previous
  // host's git verdicts must not render as the new host's truth.
  const { hostId } = useReactiveHostReadiness(client);
  return useHostQuery<HostRpcRegistry, "worktree.listByWorkspacePaths">({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listByWorkspacePaths",
    // This summary-listing path never previews ref scripts; the per-ref read is a
    // separate point-read (see worktree-scripts-dialog). v1.1 requires the field.
    // `forceRefresh: false` (v1.2): a background read serves the host's
    // TTL-cached view; only an explicit user refresh forces a disk recompute.
    params: worktreeListByWorkspacePathsParams(args.workspacePaths),
    options: {
      enabled: args.enabled && args.workspacePaths.length > 0,
      // The path set is part of the query key, so adding/removing a folder
      // lands on a fresh cache entry. Retain the prior result while the new set
      // refetches so the surviving rows keep their resolved metadata instead of
      // every row flashing "Loading folder metadata…" on each edit. Dropped on
      // host mismatch so rows fall into the pending branch until the new host
      // answers.
      placeholderData: keepPreviousDataForSameHost(hostId),
    },
  });
}
