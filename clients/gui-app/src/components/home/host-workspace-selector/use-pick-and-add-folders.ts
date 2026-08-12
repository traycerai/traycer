import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import type { HostRpcRegistry } from "@/lib/host";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
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
    // Stamp with dispatch-time hostId from the prepare result — never re-read
    // the mutable client after the await (B6 host-switch race).
    const folders = result.folders.map((folder) =>
      preparedWorkspaceFolderToWorkspaceFolderInfo(folder, result.hostId),
    );
    workspaceSource.addResolvedFolders(folders);
    return folders.length > 0;
  }, [folderActions, workspaceSource]);
}

/**
 * Locate recovery for an absent row: open the host folder picker and REPLACE
 * the dead path with whatever the user picked. A cancelled picker changes
 * nothing. Required by remote-repo-resolution D2 — re-pointing is the action
 * that unblocks readiness; add-only left the absent entry blocking forever.
 */
export function useLocateAndReplaceWorkspaceFolder(
  client: HostClient<HostRpcRegistry> | null,
  workspaceSource: HomeWorkspaceSource,
): (absentPath: string) => Promise<boolean> {
  const folderActions = useWorkspaceFolderActionsForClient(client);
  return useCallback(
    async (absentPath: string): Promise<boolean> => {
      const result = await folderActions.pickAndPrepareFolders();
      if (result === null) return false;
      const folders = result.folders.map((folder) =>
        preparedWorkspaceFolderToWorkspaceFolderInfo(folder, result.hostId),
      );
      return replaceAbsentWorkspaceFolder({
        workspaceSource,
        absentPath,
        folders,
      });
    },
    [folderActions, workspaceSource],
  );
}

/**
 * Pure replace step used by Locate tests and the hook: given a successful pick
 * result, drop the absent path then add the prepared folders. Cancelled picks
 * never reach here (the hook returns false before calling).
 */
export function replaceAbsentWorkspaceFolder(args: {
  readonly workspaceSource: Pick<
    HomeWorkspaceSource,
    "removeFolder" | "addResolvedFolders"
  >;
  readonly absentPath: string;
  readonly folders: ReadonlyArray<WorkspaceFolderInfo>;
}): boolean {
  if (args.folders.length === 0) return false;
  // Remove first so the dead path cannot keep blocking readiness even if the
  // new path is already present (add is a no-op for a duplicate).
  args.workspaceSource.removeFolder(args.absentPath);
  args.workspaceSource.addResolvedFolders(args.folders);
  return true;
}
