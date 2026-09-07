import type { WorktreeTier } from "@traycer-clients/shared/worktree/classify-worktree";

/**
 * The tiers Sweep pre-checks as safe for one Task (epic): the shared classifier proves the work landed (`merged`) or that nothing committed would be lost (`at-base-commit`).
 * The third green tier, `unreferenced`, requires zero owners and therefore can never appear among a Task's own worktrees.
 */
export function sweepEligibleTier(tier: WorktreeTier): boolean {
  return tier === "merged" || tier === "at-base-commit";
}
