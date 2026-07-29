import type { WorktreeTier } from "@traycer-clients/shared/worktree/classify-worktree";

/**
 * The tiers Sweep pre-checks as safe for one Task (epic): the shared
 * classifier proves the work landed (`merged`) or that nothing committed
 * would be lost (`at-base-commit`). The third green tier, `unreferenced`,
 * requires zero owners and therefore can never appear among a Task's own
 * worktrees. Un-enriched listings (no activity probes) carry null proof
 * fields and classify as `review`, so a row only ever pre-checks once the
 * host has actually probed it - conservative by construction. Non-green rows
 * are still listed (and checkable) in the Sweep dialog; this predicate only
 * decides the default.
 */
export function sweepEligibleTier(tier: WorktreeTier): boolean {
  return tier === "merged" || tier === "at-base-commit";
}
