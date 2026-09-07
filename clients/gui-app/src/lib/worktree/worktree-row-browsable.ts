import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { hasBlockingWorktreeSelectorReason } from "@traycer-clients/shared/worktree/worktree-row-state";

/**
 * Whether a worktree binding row is browsable by non-git surfaces (file tree, terminal creation): it just needs no blocking selector reason.
 * Setup progress/outcomes remain visible, but do not block a created directory.
 */
export function isBrowsable(row: WorktreeBindingSelectorRow): boolean {
  return !hasBlockingWorktreeSelectorReason(row);
}
