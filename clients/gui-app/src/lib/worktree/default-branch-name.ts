import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";
import { slugifyBranchSeed } from "@/lib/worktree/slugify-branch-seed";

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
function composeDefaultNewBranch(
  worktreeBranchPrefix: string,
  branchPrefix: string,
  shouldPrefix: boolean,
): string {
  const tail = pickFriendlyBranchSuffix();
  const composed =
    shouldPrefix && branchPrefix.length > 0
      ? `${worktreeBranchPrefix}${branchPrefix}-${tail}`
      : `${worktreeBranchPrefix}${tail}`;
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
