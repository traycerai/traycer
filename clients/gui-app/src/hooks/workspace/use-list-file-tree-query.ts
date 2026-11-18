import { useMemo } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
const WORKSPACE_FILE_TREE_MAX_FILES = 25_000;

/**
 * @deprecated Recursive 25k-file snapshot with a poll. Its ONLY remaining
 * caller is the file-tree panel's fallback for hosts that predate
 * `workspace.subscribeFileList` (the command palette moved to
 * `workspace.searchPaths`) - hence the explicit `enabled` gate. Do not add new
 * consumers: live trees use the `workspace.subscribeFileList` stream
 * (`use-workspace-file-list-subscription`), path search uses
 * `use-workspace-search-paths-query`. Delete this hook when the old-host
 * fallback is retired.
 */
export function useWorkspaceListFileTree(args: {
  /**
   * The host whose filesystem this lists. Its ONE caller is a host-pinned
   * surface, and this used to be absent entirely - the query took the app-wide
   * client while the panel around it was pinned elsewhere, so the fallback tree
   * listed the wrong machine's files under the pinned host's name and stamped
   * that host onto every ref opened from it.
   */
  readonly hostId: string | null;
  readonly workspacePath: string | null;
  readonly enabled: boolean;
}) {
  const { workspacePath, enabled } = args;
  const client = useHostClientForHostId(args.hostId);
  const params = useMemo(
    () => ({
      workspacePath: workspacePath ?? "",
      maxFiles: WORKSPACE_FILE_TREE_MAX_FILES,
      includeIgnored: false,
    }),
    [workspacePath],
  );

  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "workspace.listFileTree",
    params,
    options: {
      enabled: enabled && workspacePath !== null && workspacePath.length > 0,
      staleTime: 10_000,
    },
  });
}
