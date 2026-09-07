import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host/index";

/**
 * What a workspace/worktree binding row's state actually is - one derivation both clients read instead of each walking `disabledReason` / `setupState` / `isGitResolvePending` themselves.
 * This is deliberately a state, not a label: the gui pickers render it as a badge with a tone and a hover detail, and `traycer workspace list` renders it as a table cell.
 */
export type WorktreeRowState =
  | "checking"
  | "missing"
  | "setup-pending"
  | "setting-up"
  | "setup-failed"
  | "setup-cancelled"
  | "ready";

  /**
   * The fields the ladder reads.
   * A `Pick` rather than the whole row so callers holding a narrower shape (and tests holding a fixture) can use it, and so the inputs this derivation actually depends on are stated rather than implied.
   */
export type WorktreeRowStateInput = Pick<
  WorktreeBindingSelectorRowV12,
  "disabledReason" | "isGitRepo" | "mode" | "setupState" | "isGitResolvePending"
>;

export function isWorkspaceResolvePending(
  row: Pick<WorktreeBindingSelectorRowV12, "isGitResolvePending">,
): boolean {
  return row.isGitResolvePending;
}

/**
 * Whether a row is genuinely unusable, as opposed to merely mid-setup.
 * The current host treats creation as the selector gate: once a worktree exists, setup progress and outcomes live in `setupState` and the row stays selectable with `disabledReason: null`.
 */
export function hasBlockingWorktreeSelectorReason(
  row: Pick<
    WorktreeBindingSelectorRowV12,
    "disabledReason" | "isGitRepo" | "mode"
  >,
): boolean {
  switch (row.disabledReason) {
    case null:
      return false;
    case "setup_pending":
    case "setup_running":
    case "setup_failed":
    case "setup_cancelled":
      return row.mode === "worktree" && !row.isGitRepo;
    case "missing_worktree_path":
      return true;
  }
}

/**
 * The row's state, per the precedence documented on `WorktreeRowState`.
 * Two details are load-bearing and both exist to avoid asserting something the host has not established: - A blocked row splits on `isWorkspaceResolvePending` before it is called missing.
 */
export function worktreeRowState(row: WorktreeRowStateInput): WorktreeRowState {
  if (hasBlockingWorktreeSelectorReason(row)) {
    return isWorkspaceResolvePending(row) ? "checking" : "missing";
  }
  if (row.setupState === "pending" || row.disabledReason === "setup_pending") {
    return "setup-pending";
  }
  if (row.setupState === "running" || row.disabledReason === "setup_running") {
    return "setting-up";
  }
  if (row.setupState === "failed" || row.disabledReason === "setup_failed") {
    return "setup-failed";
  }
  if (
    row.setupState === "cancelled" ||
    row.disabledReason === "setup_cancelled"
  ) {
    return "setup-cancelled";
  }
  return "ready";
}
