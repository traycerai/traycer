import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 500_000;

export function useWorkspaceReadFile(
  client: HostClient<HostRpcRegistry> | null,
  workspacePath: string | null,
  filePath: string | null,
) {
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
      // A fresh mount (closing and reopening a tab) must never surface a
      // stale cached read - the file may have changed externally while the
      // tab was closed. Scoped here, not globally: other host queries still
      // want cache-first mounts.
      refetchOnMount: "always",
    },
  });
}
