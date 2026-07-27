import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";

/**
 * The repo-identity shape shared structurally by worktree listing entries and
 * folder intents. Declared here rather than imported: the protocol keeps its
 * `repoIdentifierSchema` private, and the neighbouring exported aliases
 * (`TaskRepoIdentifier`, `PrRepoIdentifier`) belong to unrelated surfaces.
 */
export interface RemovedBranchRepo {
  readonly owner: string;
  readonly repo: string;
}

/** A branch a completed removal deleted, qualified by its repository. */
export interface RemovedBranchRef {
  readonly repoIdentifier: RemovedBranchRepo | null;
  readonly branch: string;
}

/**
 * What a completed worktree removal (Sweep today; any delete flow that knows
 * what it removed) took off this host: the worktree directories and the
 * branches their teardown deleted.
 */
export interface RemovedWorktreeRefs {
  readonly worktreePaths: ReadonlySet<string>;
  readonly branches: ReadonlyArray<RemovedBranchRef>;
}

/**
 * Two repo identities refer to the same repository. A `null` on either side
 * means the repo could not be identified (no parseable origin), so identity
 * cannot be used to RULE OUT a match - the name comparison then stands alone,
 * which is the conservative direction for a purge.
 */
function repoMatches(
  left: RemovedBranchRepo | null,
  right: RemovedBranchRepo | null,
): boolean {
  if (left === null || right === null) return true;
  return left.owner === right.owner && left.repo === right.repo;
}

/**
 * Whether a staged/remembered folder intent references a removed worktree and
 * can therefore no longer materialize: an `import` of a removed directory, an
 * existing-branch checkout of a deleted branch, or a new-branch fork whose
 * SOURCE branch was deleted. Branch matches are qualified by repository, so
 * removing `feat/x` in one repo leaves another repo's `feat/x` intent intact
 * on a cross-repo epic.
 */
export function worktreeFolderIntentReferencesRemoved(
  intent: WorktreeFolderIntent,
  removed: RemovedWorktreeRefs,
): boolean {
  if (intent.kind === "import") {
    return removed.worktreePaths.has(intent.worktreePath);
  }
  if (intent.kind === "worktree") {
    const branchName =
      intent.branch.type === "existing"
        ? intent.branch.name
        : intent.branch.source;
    return removed.branches.some(
      (ref) =>
        ref.branch === branchName &&
        repoMatches(ref.repoIdentifier, intent.repoIdentifier),
    );
  }
  return false;
}
