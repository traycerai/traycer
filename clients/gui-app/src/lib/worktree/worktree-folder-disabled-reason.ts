import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { isWorkspaceResolvePending } from "@/lib/worktree/worktree-row-resolve-pending";

export function formatWorktreeFolderDisabledReason(
  row: WorktreeBindingSelectorRowV12,
): string | null {
  const reason: string | null = row.disabledReason;
  if (reason === null) return null;
  if (reason === "setup_pending") return "pending";
  if (reason === "setup_running") return "setup";
  if (reason === "setup_failed") return "failed";
  if (reason === "setup_cancelled") return "cancelled";
  if (reason === "missing_worktree_path") return "missing";
  return "disabled";
}

/**
 * Row badge for the browsable worktree pickers (terminal creation, file
 * tree). `pending: true` marks a row whose only defect is unverified git
 * facts (see `isWorkspaceResolvePending`): it renders as "checking" in a
 * muted badge instead of a destructive "missing", because the host has not
 * actually established that the path is gone. A pending row with no
 * disabled reason (a cold local folder) stays browsable and gets no badge -
 * these surfaces never needed git facts to open a folder.
 */
export type WorktreeFolderRowBadge = {
  readonly label: string;
  readonly pending: boolean;
};

export function worktreeFolderRowBadge(
  row: WorktreeBindingSelectorRowV12,
): WorktreeFolderRowBadge | null {
  if (row.disabledReason === null) return null;
  if (isWorkspaceResolvePending(row))
    return { label: "checking", pending: true };
  const label = formatWorktreeFolderDisabledReason(row);
  return label === null ? null : { label, pending: false };
}
