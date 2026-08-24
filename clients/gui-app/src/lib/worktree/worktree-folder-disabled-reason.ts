import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { isWorkspaceResolvePending } from "@/lib/worktree/worktree-row-resolve-pending";

/**
 * The host now treats creation as the selector gate: once a worktree exists,
 * setup progress and outcomes remain in `setupState` without disabling the
 * row. Treat legacy setup disabled reasons the same way so a new client also
 * unlocks promptly against an older host.
 */
export function hasBlockingWorktreeSelectorReason(
  row: Pick<
    WorktreeBindingSelectorRowV12,
    "disabledReason" | "isGitRepo" | "mode"
  >,
): boolean {
  if (
    row.disabledReason === "setup_pending" ||
    row.disabledReason === "setup_running" ||
    row.disabledReason === "setup_failed" ||
    row.disabledReason === "setup_cancelled"
  ) {
    // Older hosts projected setup lifecycle as disabled reasons. Creation is
    // the real gate, so relax every setup reason once disk truth says the Git
    // worktree exists; a missing/unverified worktree remains blocked.
    return row.mode === "worktree" && !row.isGitRepo;
  }
  return row.disabledReason !== null;
}

export function formatWorktreeFolderDisabledReason(
  row: WorktreeBindingSelectorRowV12,
): string | null {
  const reason: string | null = row.disabledReason;
  if (reason === null) return null;
  if (
    reason === "setup_pending" ||
    reason === "setup_running" ||
    reason === "setup_failed" ||
    reason === "setup_cancelled"
  ) {
    return hasBlockingWorktreeSelectorReason(row) ? "missing" : null;
  }
  if (reason === "missing_worktree_path") return "missing";
  return "disabled";
}

/**
 * Row badge for worktree pickers (terminal creation, file tree).
 * `disabled` is deliberately independent from badge visibility: setup can
 * remain visible as progress or a warning without blocking the created row.
 * `pending: true` marks a row whose only defect is unverified git facts (see
 * `isWorkspaceResolvePending`), so it renders as "checking" instead of a
 * destructive "missing". A cold local folder stays browsable with no badge.
 */
export type WorktreeFolderRowBadge = {
  readonly label: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly tone: "neutral" | "warning" | "error";
  readonly detail: string;
};

export function worktreeFolderRowBadge(
  row: WorktreeBindingSelectorRowV12,
): WorktreeFolderRowBadge | null {
  if (hasBlockingWorktreeSelectorReason(row)) {
    if (isWorkspaceResolvePending(row)) {
      return {
        label: "checking",
        pending: true,
        disabled: true,
        tone: "neutral",
        detail: "Checking whether the worktree is available.",
      };
    }
    const label = formatWorktreeFolderDisabledReason(row);
    return label === null
      ? null
      : {
          label,
          pending: false,
          disabled: true,
          tone: "error",
          detail:
            label === "missing"
              ? "This worktree is unavailable because its directory could not be found."
              : "This workspace is unavailable.",
        };
  }
  if (row.setupState === "pending" || row.disabledReason === "setup_pending") {
    return {
      label: "setup pending",
      pending: false,
      disabled: false,
      tone: "neutral",
      detail: "The worktree is ready to use. Setup is waiting to start.",
    };
  }
  if (row.setupState === "running" || row.disabledReason === "setup_running") {
    return {
      label: "setting up",
      pending: true,
      disabled: false,
      tone: "neutral",
      detail: "The worktree is ready to use while setup continues.",
    };
  }
  if (row.setupState === "failed" || row.disabledReason === "setup_failed") {
    return {
      label: "setup failed",
      pending: false,
      disabled: false,
      tone: "warning",
      detail: "Setup did not complete, but the worktree is still usable.",
    };
  }
  if (
    row.setupState === "cancelled" ||
    row.disabledReason === "setup_cancelled"
  ) {
    return {
      label: "setup cancelled",
      pending: false,
      disabled: false,
      tone: "warning",
      detail: "Setup was cancelled, but the worktree is still usable.",
    };
  }
  return null;
}
