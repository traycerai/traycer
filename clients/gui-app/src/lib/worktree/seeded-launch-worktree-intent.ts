import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import {
  readStagedWorktreeIntent,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { readSeededWorkspaceSnapshot } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { effectiveWorktreeIntent } from "./effective-worktree-intent";

/**
 * The single read-back for a seeded launcher - the fork dialogs and the
 * terminal-agent launcher all call this at submit time.
 *
 * Reads back the LIVE seeded-workspace snapshot (falling back to the seed the
 * launcher was opened with, if the picker never mounted/edited it) and
 * canonicalizes: every folder gets exactly one entry (staged, else the seed's
 * own entry, else a synthesized default), with `isPrimary` stamped from the
 * CURRENT resolved primary - never from a possibly-stale staged/seed bit.
 * This is what lets "Set as primary" onto a folder with no staged entry (a
 * non-git folder, never auto-seeded) still reach launch correctly, without
 * ever writing a synthetic staged entry merely to carry the primary flag.
 */
export interface SeededLaunchWorkspace {
  readonly worktreeIntent: WorktreeIntent | null;
  readonly folderCount: number;
}

export function readSeededLaunchWorkspace(args: {
  readonly stagingKey: WorktreeStagingKey;
  readonly seedIntent: WorktreeIntent | null;
  readonly fallbackWorkspace: LandingDraftWorkspaceSnapshot | null;
}): SeededLaunchWorkspace {
  const workspace =
    readSeededWorkspaceSnapshot(args.stagingKey) ??
    args.fallbackWorkspace ??
    readGlobalWorkspaceSnapshot();
  return {
    worktreeIntent: effectiveWorktreeIntent({
      workspace,
      seedIntent: args.seedIntent,
      stagedIntent: readStagedWorktreeIntent(args.stagingKey),
    }),
    folderCount: workspace.folders.length,
  };
}

function readGlobalWorkspaceSnapshot(): LandingDraftWorkspaceSnapshot {
  const workspace = useWorkspaceFoldersStore.getState();
  return {
    folders: workspace.folders,
    folderInfoByPath: workspace.folderInfoByPath,
    primaryPath: workspace.primaryPath,
  };
}
