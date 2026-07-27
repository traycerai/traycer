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
 * Whether two repo identities may refer to the same repository.
 *
 * Both known: they must be equal. A removed `feat/x` in `acme/app` must never
 * purge a live `feat/x` intent in `acme/other`.
 *
 * Both unknown: the branch name is all either side has, so it decides. This is
 * the local-repo-with-no-parseable-origin case, and it is the one that must
 * still purge - otherwise a swept worktree in such a repo keeps being offered
 * as an "existing worktree" in new chats forever, which is the bug this purge
 * exists to fix.
 *
 * One known, one unknown: NO match. An unidentifiable side cannot be shown to
 * be the same repo as an identified one, and guessing costs a valid user
 * selection. Erring toward under-purge here is right: the worst case is one
 * stale remembered default, whereas guessing wrong destroys a good one.
 */
function repoMatches(
  left: RemovedBranchRepo | null,
  right: RemovedBranchRepo | null,
): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
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
