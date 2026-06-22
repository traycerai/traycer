import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";

export function formatWorktreeFolderDisabledReason(
  row: WorktreeBindingSelectorRow,
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
