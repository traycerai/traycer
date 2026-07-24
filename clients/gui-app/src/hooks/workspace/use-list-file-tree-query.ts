import { useMemo } from "react";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
const WORKSPACE_FILE_TREE_MAX_FILES = 25_000;

/**
 * Recursive 25k-file snapshot with a poll. Still the source for surfaces that
 * need a whole-workspace path list (command-palette fuzzy search), and the
 * file-tree panel's fallback for hosts that predate
 * `workspace.subscribeFileList` - hence the explicit `enabled` gate rather
 * than an implicit "always on".
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
