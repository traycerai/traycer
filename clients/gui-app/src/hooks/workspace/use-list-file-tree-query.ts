import { useMemo } from "react";
import { useHostClient } from "@/lib/host";
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
export function useWorkspaceListFileTree(
  workspacePath: string | null,
  enabled: boolean,
) {
  const client = useHostClient();
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
