import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeWorkspaceSource } from "./use-home-workspace-source";

/**
 * Opens the host's folder picker and adds the chosen folders to the ACTIVE
 * workspace representation (landing draft / modal / seed / global) through
 * `HomeWorkspaceSource`. Shared by the workspace picker's "Add folder" and the
 * landing terminal panel's empty state, so a folder picked from either surface
 * lands in the same place and resolves the same primary.
 *
 * Resolves `true` when at least one folder was added, `false` on cancel.
 */
export function usePickAndAddWorkspaceFolders(
  client: HostClient<HostRpcRegistry> | null,
  workspaceSource: HomeWorkspaceSource,
): () => Promise<boolean> {
  const folderActions = useWorkspaceFolderActionsForClient(client);
  return useCallback(async (): Promise<boolean> => {
    const result = await folderActions.pickAndPrepareFolders();
    if (result === null) return false;
    const folders = result.folders.map(
      preparedWorkspaceFolderToWorkspaceFolderInfo,
    );
    workspaceSource.addResolvedFolders(folders);
    return folders.length > 0;
  }, [folderActions, workspaceSource]);
}
