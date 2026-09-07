import { useMemo } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
const WORKSPACE_FILE_TREE_MAX_FILES = 25_000;

/**
 * @deprecated Recursive 25k-file snapshot with a poll. Only remaining caller is the file-tree fallback for hosts that predate `workspace.subscribeFileList`. Do not add consumers.
 */
export function useWorkspaceListFileTree(args: {
  /** The host whose filesystem this lists. */
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
