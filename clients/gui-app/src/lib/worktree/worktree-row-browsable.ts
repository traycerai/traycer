import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { hasBlockingWorktreeSelectorReason } from "@/lib/worktree/worktree-folder-disabled-reason";

/**
 * Whether a worktree binding row is browsable by non-git surfaces (file tree,
 * terminal creation): it just needs no blocking selector reason. Setup
 * progress/outcomes remain visible, but do not block a created directory.
 * Non-git rows ARE browsable. Shared so the file-tree
 * chip summary and the sidebar's mounted roots filter disabled rows the same
 * way and can't drift. Git surfaces use `isGitSelectable` instead.
 */
export function isBrowsable(row: WorktreeBindingSelectorRow): boolean {
  return !hasBlockingWorktreeSelectorReason(row);
}
