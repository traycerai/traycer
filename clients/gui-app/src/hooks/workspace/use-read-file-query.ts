import { useMemo } from "react";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 500_000;

export function useWorkspaceReadFile(
  workspacePath: string | null,
  filePath: string | null,
) {
  const client = useHostClient();
  const params = useMemo(
    () => ({
      workspacePath: workspacePath ?? "",
      filePath: filePath ?? "",
      maxBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES,
    }),
    [workspacePath, filePath],
  );

  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "workspace.readFile",
    params,
    options: {
      enabled:
        workspacePath !== null &&
        filePath !== null &&
        workspacePath.length > 0 &&
        filePath.length > 0,
      staleTime: 5_000,
    },
  });
}
