import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";

export function deriveWorkspaceMode(
  workspaceFolderCount: number,
  worktreeIntent: WorktreeIntent | null,
): WorktreeBindingWorkspaceMode {
  return workspaceFolderCount === 0 ||
    (worktreeIntent !== null && worktreeIntent.entries.length === 0)
    ? "folderless"
    : "inherit";
}
