import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";
import { slugifyBranchSeed } from "@/lib/worktree/slugify-branch-seed";

/**
 * Default new-branch names for the unified worktree picker, keyed by workspace
 * path. Each name is a fresh random friendly slug (e.g. `traycer/swift-otter`);
 * the host owns final collision-suffixing at create time. The repo prefix is
 * only added when several git workspaces are configured at once, so multi-repo
 * worktrees branched together stay distinguishable.
 */
export function buildDefaultBranchByPath(
  workspaces: ReadonlyArray<WorktreeWorkspaceSummary>,
  shouldPrefixDefaultBranches: boolean,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.workspacePath,
      composeDefaultNewBranch(
        branchPrefixFor(workspace),
        shouldPrefixDefaultBranches,
      ),
    ]),
  );
}

function composeDefaultNewBranch(
  branchPrefix: string,
  shouldPrefix: boolean,
): string {
  const tail = pickFriendlyBranchSuffix();
  const composed =
    shouldPrefix && branchPrefix.length > 0
      ? `traycer/${branchPrefix}-${tail}`
      : `traycer/${tail}`;
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
