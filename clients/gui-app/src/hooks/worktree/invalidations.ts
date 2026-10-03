import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { enrichmentQueryPaths } from "@/lib/query-keys/worktree-enrichment-keys";
import { worktreePathMatcher } from "@/lib/worktree/worktree-path-match";

// Listed explicitly so binding-mutation success doesn't invalidate
// unrelated caches like `terminal.list` or `agent.list`.
export const WORKTREE_BINDING_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "worktree.listBindingsForEpic",
  "worktree.listByWorkspacePaths",
  "worktree.getBinding",
  "worktree.listBranches",
];

/** Mark affected entries stale; only mounted observers refetch now. */
export function invalidateWorktreeListingAndBindingCaches(
  queryClient: QueryClient,
  hostId: string,
  worktreePaths: readonly string[],
): void {
  for (const queryKey of affectedWorktreeQueryKeys(
    queryClient,
    hostId,
    worktreePaths,
  )) {
    void queryClient.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: "active",
    });
  }
}

/** Shared membership evidence for deletion completion and path-scoped pushes. */
export function affectedWorktreeQueryKeys(
  queryClient: QueryClient,
  hostId: string,
  worktreePaths: readonly string[],
): ReadonlySet<QueryKey> {
  const isAffectedPath = worktreePathMatcher(new Set(worktreePaths));
  const workspacePaths = new Set(worktreePaths);
  const keys = new Set<QueryKey>();
  if (worktreePaths.length === 0) return keys;
  const queries = queryClient.getQueryCache().findAll({
    queryKey: hostQueryKeys.scope(hostId),
  });
  const collectBinding = (key: QueryKey): void => {
    const data =
      queryClient.getQueryData<
        ResponseOfMethod<HostRpcRegistry, "worktree.getBinding">
      >(key);
    if (
      data?.missingWorktreePaths.some(isAffectedPath) ||
      (data?.binding === null && data.missingWorktreePaths.length > 0)
    )
      keys.add(key);
    for (const entry of data?.binding?.entries ?? []) {
      // Only created worktrees carry the host's managed path. Imports and
      // local folders can alias a deleted checkout or live inside it.
      if (
        entry.mode === "worktree" &&
        !entry.isImported &&
        entry.worktreePath !== null &&
        !isAffectedPath(entry.workspacePath) &&
        !isAffectedPath(entry.worktreePath)
      ) {
        continue;
      }
      workspacePaths.add(entry.workspacePath);
      keys.add(key);
    }
  };
  const collectEpicBindings = (key: QueryKey): void => {
    const data =
      queryClient.getQueryData<
        ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">
      >(key);
    for (const row of data?.rows ?? []) {
      if (
        row.mode === "worktree" &&
        !row.isImported &&
        row.worktreePath !== null &&
        !isAffectedPath(row.runningDir) &&
        !isAffectedPath(row.worktreePath)
      )
        continue;
      workspacePaths.add(row.workspacePath);
      keys.add(key);
    }
  };
  const collectWorkspaceListing = (key: QueryKey): void => {
    const data =
      queryClient.getQueryData<
        ResponseOfMethod<HostRpcRegistry, "worktree.listByWorkspacePaths">
      >(key);
    for (const workspace of data?.workspaces ?? []) {
      if (
        !workspace.worktrees.some((entry) => isAffectedPath(entry.worktreePath))
      ) {
        continue;
      }
      workspacePaths.add(workspace.workspacePath);
      keys.add(key);
    }
  };
  // Collect workspace membership before examining branch/listing parameters.
  for (const { queryKey: key } of queries) {
    switch (key[2]) {
      case "worktree.getBinding":
        collectBinding(key);
        break;
      case "worktree.listBindingsForEpic":
        collectEpicBindings(key);
        break;
      case "worktree.listByWorkspacePaths":
        collectWorkspaceListing(key);
        break;
    }
  }

  const isAffectedWorkspace = worktreePathMatcher(workspacePaths);
  const listingIncludesAffectedPath = (key: QueryKey): boolean => {
    const method = key[2];
    const params = key[3];
    if (params === null || typeof params !== "object") return false;
    if (method === "worktree.listAllForHost") {
      // Paged listings shift after deletion; per-path enrichment only changes
      // for deleted paths. Inactive entries remain stale until observed.
      const paths = enrichmentQueryPaths(key);
      if (paths === null || paths.some(isAffectedPath)) return true;
    } else if (method === "worktree.listBranches") {
      if (
        "workspacePath" in params &&
        typeof params.workspacePath === "string" &&
        isAffectedWorkspace(params.workspacePath)
      )
        return true;
    } else if (method === "worktree.listByWorkspacePaths") {
      if (
        "workspacePaths" in params &&
        Array.isArray(params.workspacePaths) &&
        params.workspacePaths.some(
          (path) => typeof path === "string" && isAffectedWorkspace(path),
        )
      )
        return true;
    }
    return false;
  };
  for (const query of queries) {
    const key = query.queryKey;
    const method = key[2];
    const params = key[3];
    if (params === null || typeof params !== "object") continue;
    if (listingIncludesAffectedPath(key)) keys.add(key);
    // Without a settled snapshot there is no membership evidence to narrow.
    if (
      query.state.data === undefined &&
      WORKTREE_BINDING_INVALIDATIONS.some((candidate) => candidate === method)
    )
      keys.add(key);
  }

  return keys;
}
