import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";

/**
 * What a completed worktree removal (Sweep today; any delete flow that knows
 * what it removed) took off this host: the worktree directories and the
 * branches their teardown deleted.
 */
export interface RemovedWorktreeRefs {
  readonly worktreePaths: ReadonlySet<string>;
  readonly branches: ReadonlySet<string>;
}

/**
 * Whether a staged/remembered folder intent references a removed worktree and
 * can therefore no longer materialize: an `import` of a removed directory, an
 * existing-branch checkout of a deleted branch, or a new-branch fork whose
 * SOURCE branch was deleted. Branch matching is by name only (no repo
 * qualification): a cross-repo name collision at worst over-purges a
 * remembered default, which just re-seeds to the standard new-worktree choice
 * - while under-purging would keep offering a selection that can never be
 * created.
 */
export function worktreeFolderIntentReferencesRemoved(
  intent: WorktreeFolderIntent,
  removed: RemovedWorktreeRefs,
): boolean {
  if (intent.kind === "import") {
    return removed.worktreePaths.has(intent.worktreePath);
  }
  if (intent.kind === "worktree") {
    if (intent.branch.type === "existing") {
      return removed.branches.has(intent.branch.name);
    }
    return removed.branches.has(intent.branch.source);
  }
  return false;
}
