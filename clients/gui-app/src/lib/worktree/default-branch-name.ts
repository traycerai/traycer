import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";
import { slugifyBranchSeed } from "@/lib/worktree/slugify-branch-seed";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from "@/stores/settings/settings-store";

/**
 * Default new-branch names for the unified worktree picker, keyed by workspace
 * path. Each name is a fresh random friendly slug (e.g. `traycer/swift-otter`
 * under the default configured prefix); the host owns final
 * collision-suffixing at create time. The repo prefix is only added when
 * several git workspaces are configured at once, so multi-repo worktrees
 * branched together stay distinguishable.
 */
export function buildDefaultBranchByPath(
  workspaces: ReadonlyArray<WorktreeWorkspaceSummary>,
  shouldPrefixDefaultBranches: boolean,
  worktreeBranchPrefix: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.workspacePath,
      composeDefaultNewBranch(
        worktreeBranchPrefix,
        branchPrefixFor(workspace),
        shouldPrefixDefaultBranches,
      ),
    ]),
  );
}

// `worktreeBranchPrefix` is the user-configured setting (default "traycer/"),
// used verbatim - no separator is auto-appended, so an empty string means no
// prefix at all. `branchPrefix` is the per-workspace repo/folder slug added
// only when several git workspaces are staged together.
//
// This is the single choke point where the configured prefix reaches branch
// composition - the editor's own validation only guards its own input, not a
// hand-edited localStorage value or a direct store write, so it is
// re-validated here and an invalid prefix falls back to the default rather
// than flowing verbatim into a branch name.
function composeDefaultNewBranch(
  worktreeBranchPrefix: string,
  branchPrefix: string,
  shouldPrefix: boolean,
): string {
  const prefix =
    worktreeBranchPrefixError(worktreeBranchPrefix) === null
      ? worktreeBranchPrefix
      : DEFAULT_WORKTREE_BRANCH_PREFIX;
  const tail = pickFriendlyBranchSuffix();
  const composed =
    shouldPrefix && branchPrefix.length > 0
      ? `${prefix}${branchPrefix}-${tail}`
      : `${prefix}${tail}`;
  return composed.slice(0, 80);
}

function branchPrefixFor(workspace: WorktreeWorkspaceSummary): string {
  const repoPrefix =
    workspace.repoIdentifier === null
      ? ""
      : slugifyBranchSeed(workspace.repoIdentifier.repo);
  if (repoPrefix.length > 0) return repoPrefix;
  return slugifyBranchSeed(workspaceFolderName(workspace.workspacePath));
}
