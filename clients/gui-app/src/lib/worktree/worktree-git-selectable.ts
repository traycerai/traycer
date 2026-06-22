import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";

/**
 * Whether a worktree binding row can run Git operations: it must be a git repo
 * and not disabled (setup pending/failed, missing worktree, ...). Shared by
 * every Git surface (diff panel, worktree picker, command-palette diff opener)
 * so git-eligibility stays consistent across them - non-git and file-tree /
 * terminal surfaces deliberately do NOT use this gate.
 */
export function isGitSelectable(row: WorktreeBindingSelectorRow): boolean {
  return row.isGitRepo && row.disabledReason === null;
}
