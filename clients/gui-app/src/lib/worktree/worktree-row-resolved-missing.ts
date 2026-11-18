import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { isWorkspaceResolvePending } from "@traycer-clients/shared/worktree/worktree-row-state";

/**
 * Host-PROVEN gone: the row resolved (not a pending git-fact placeholder) with
 * the missing-worktree reason. Distinct from a pending row, whose "checking"
 * state may still converge to selectable.
 */
export function isResolvedMissingRow(
  row: WorktreeBindingSelectorRowV12,
): boolean {
  return (
    row.disabledReason === "missing_worktree_path" &&
    !isWorkspaceResolvePending(row)
  );
}

/**
 * The surface's current selection, identified the way rows actually are:
 * by host AND path. A path alone is ambiguous - the same `runningDir` can
 * exist on two hosts, and exempting by path would keep another host's dead
 * row visible.
 */
export interface SelectedWorktreeRef {
  readonly hostId: string;
  readonly runningDir: string;
}

/**
 * Drops host-proven-missing rows from browse/launch pickers (terminal
 * creation, file tree, git diff): binding rows deliberately outlive worktree
 * deletion so an OWNING chat can recover via its own picker, but on
 * non-owner surfaces a long-dead row is pure noise - it can never be
 * launched or browsed. `keepSelected` exempts the surface's CURRENT
 * selection so a worktree deleted while selected stays visible (as its
 * disabled badge) instead of silently vanishing out from under the user.
 */
export function withoutResolvedMissingRows(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
  keepSelected: SelectedWorktreeRef | null,
): ReadonlyArray<WorktreeBindingSelectorRowV12> {
  return rows.filter(
    (row) =>
      !isResolvedMissingRow(row) ||
      (keepSelected !== null &&
        row.hostId === keepSelected.hostId &&
        row.runningDir === keepSelected.runningDir),
  );
}
