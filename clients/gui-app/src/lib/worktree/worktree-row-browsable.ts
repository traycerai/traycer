import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";

/**
 * Whether a worktree binding row is browsable by non-git surfaces (file tree,
 * terminal creation): it just needs to not be disabled (setup pending/failed,
 * missing worktree, ...). Non-git rows ARE browsable. Shared so the file-tree
 * chip summary and the sidebar's mounted roots filter disabled rows the same
 * way and can't drift. Git surfaces use `isGitSelectable` instead.
 */
export function isBrowsable(row: WorktreeBindingSelectorRow): boolean {
  return row.disabledReason === null;
}
