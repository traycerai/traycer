import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  readStagedWorktreeIntent,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { readSeededWorkspaceSnapshot } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { effectiveWorktreeIntent } from "./effective-worktree-intent";

/**
 * The single read-back for a seeded launcher - the fork dialogs and the terminal-agent launcher all call this at submit time.
 */
export interface SeededLaunchWorkspace {
  readonly worktreeIntent: WorktreeIntent | null;
  readonly folderCount: number;
}

export function readSeededLaunchWorkspace(args: {
  readonly stagingKey: WorktreeStagingKey;
  readonly seedIntent: WorktreeIntent | null;
  readonly fallbackWorkspace: LandingDraftWorkspaceSnapshot | null;
  /**
   * The launch host: its per-host folder bucket backs the global fallback (folder paths are host-local, so another host's bucket would launch against paths that may not exist on the target machine).
   */
  readonly hostId: string | null;
}): SeededLaunchWorkspace {
  const workspace =
    readSeededWorkspaceSnapshot(args.stagingKey) ??
    args.fallbackWorkspace ??
    readGlobalWorkspaceSnapshot(args.hostId);
  return {
    worktreeIntent: effectiveWorktreeIntent({
      workspace,
      seedIntent: args.seedIntent,
      stagedIntent: readStagedWorktreeIntent(args.stagingKey),
    }),
    folderCount: workspace.folders.length,
  };
}

function readGlobalWorkspaceSnapshot(
  hostId: string | null,
): LandingDraftWorkspaceSnapshot {
  const bucket = selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    hostId,
  );
  return {
    folders: bucket.folders,
    folderInfoByPath: bucket.folderInfoByPath,
    primaryPath: bucket.primaryPath,
  };
}
