import { useMemo } from "react";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
const WORKSPACE_FILE_TREE_MAX_FILES = 25_000;

export function useWorkspaceListFileTree(workspacePath: string | null) {
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
      enabled: workspacePath !== null && workspacePath.length > 0,
      staleTime: 10_000,
    },
  });
}
