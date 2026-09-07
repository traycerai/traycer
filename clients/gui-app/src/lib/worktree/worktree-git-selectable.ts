import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";

/**
 * Whether a worktree binding row can run Git operations: it must be a git repo and have no blocking selector reason.
 * Setup runs as background enrichment; its progress/outcome stays visible without making a created repo unusable.
 */
export function isGitSelectable(row: WorktreeBindingSelectorRow): boolean {
  return row.isGitRepo && isBrowsable(row);
}
