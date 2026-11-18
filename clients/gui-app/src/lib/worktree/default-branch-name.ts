import type {
  RepoBranchPrefixState,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";
import { slugifyBranchSeed } from "@/lib/worktree/slugify-branch-seed";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";
import { resolveEffectiveBranchPrefix } from "@/lib/worktree/effective-branch-prefix";
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from "@/stores/settings/settings-store";

/** One workspace's proposed branch name, plus its fallback warning (if any). */
export interface DefaultBranchDescriptor {
  readonly name: string;
  readonly warning: string | null;
}

/** Fallback for a path missing from a `buildDefaultBranchByPath` result. */
export const EMPTY_DEFAULT_BRANCH: DefaultBranchDescriptor = {
  name: "",
  warning: null,
};

/**
 * Default new-branch names for the unified worktree picker, keyed by workspace
 * path, paired with the warning `resolveEffectiveBranchPrefix` produces when
 * a repository override is invalid or unreadable (`null` for an absent or
 * valid override). Each name is a fresh random friendly slug (e.g.
 * `traycer/swift-otter` under the default configured prefix); the host owns
 * final collision-suffixing at create time. The repo prefix is only added
 * when several git workspaces are configured at once, so multi-repo
 * worktrees branched together stay distinguishable.
 *
 * `globalBranchPrefix` is the app-profile-scoped fallback. Each workspace
 * resolves its OWN effective prefix independently - `repo override ??
 * global` via `resolveEffectiveBranchPrefix` - so a multi-repo Task can
 * legitimately produce different prefixes per workspace. The creation
 * picker renders the warning on the affected row so a fallback that changed
 * the generated proposal is visible without opening Environment; creation
 * itself stays unblocked.
 */
export function buildDefaultBranchByPath(
  workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV14>,
  shouldPrefixDefaultBranches: boolean,
  globalBranchPrefix: string,
): Readonly<Record<string, DefaultBranchDescriptor>> {
  return Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.workspacePath,
      buildDefaultBranchEntry(
        workspace,
        shouldPrefixDefaultBranches,
        globalBranchPrefix,
        pickFriendlyBranchSuffix(),
      ),
    ]),
  );
}

function buildDefaultBranchEntry(
  workspace: WorktreeWorkspaceSummaryV14,
  shouldPrefixDefaultBranches: boolean,
  globalBranchPrefix: string,
  suffix: string,
): DefaultBranchDescriptor {
  const resolved = resolveEffectiveBranchPrefix(
    workspace.repoBranchPrefix,
    globalBranchPrefix,
    workspace.workspacePath,
  );
  return {
    name: composeDefaultNewBranch(
      resolved.value,
      branchPrefixFor(workspace),
      shouldPrefixDefaultBranches,
      suffix,
    ),
    warning: resolved.warning,
  };
}

/**
 * Regenerates ONE workspace's proposed branch name using
 * `freshRepoBranchPrefix` INSTEAD OF whatever `repoBranchPrefix` its entry in
 * `workspaces` currently holds. Deliberately ignores the matching summary's
 * own `repoBranchPrefix` field (only its `workspacePath`/`repoIdentifier`
 * matter) - the picker's cached workspace summaries only reflect a saved
 * repo-prefix override once `worktree.listByWorkspacePaths` has been
 * invalidated AND refetched, an async step a "regenerate" click must not be
 * made to wait on. `null` when `workspacePath` isn't in `workspaces`.
 *
 * `suffix` is supplied by the caller rather than picked here (contrast
 * `buildDefaultBranchByPath`, which picks a fresh one per workspace) - the
 * Environment dialog's Branch naming section calls this with the SAME stable
 * suffix it already used for its live "Effective branch" preview, so the
 * displayed candidate and whatever ends up staged are guaranteed to be the
 * exact same branch name, not two independent random picks.
 */
export function regenerateSingleWorkspaceBranchName(input: {
  readonly workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV14>;
  readonly globalBranchPrefix: string;
  readonly workspacePath: string;
  readonly freshRepoBranchPrefix: RepoBranchPrefixState;
  readonly suffix: string;
}): string | null {
  const summary = input.workspaces.find(
    (ws) => ws.workspacePath === input.workspacePath,
  );
  if (summary === undefined) return null;
  return buildDefaultBranchEntry(
    { ...summary, repoBranchPrefix: input.freshRepoBranchPrefix },
    input.workspaces.length > 1,
    input.globalBranchPrefix,
    input.suffix,
  ).name;
}

// `worktreeBranchPrefix` is the resolved effective prefix (repo override ??
// global), used verbatim - no separator is auto-appended, so an empty string
// means no prefix at all. `branchPrefix` is the per-workspace repo/folder
// slug added only when several git workspaces are staged together.
//
// This is the single choke point where the configured prefix reaches branch
// composition - the editors' own validation only guards their own input, not
// a hand-edited localStorage value, direct store write, or hand-edited
// `environment.json`, so it is re-validated here and an invalid prefix falls
// back to the default rather than flowing verbatim into a branch name.
function composeDefaultNewBranch(
  worktreeBranchPrefix: string,
  branchPrefix: string,
  shouldPrefix: boolean,
  suffix: string,
): string {
  const prefix =
    worktreeBranchPrefixError(worktreeBranchPrefix) === null
      ? worktreeBranchPrefix
      : DEFAULT_WORKTREE_BRANCH_PREFIX;
  const composed =
    shouldPrefix && branchPrefix.length > 0
      ? `${prefix}${branchPrefix}-${suffix}`
      : `${prefix}${suffix}`;
  return composed.slice(0, 80);
}

function branchPrefixFor(workspace: WorktreeWorkspaceSummaryV14): string {
  const repoPrefix =
    workspace.repoIdentifier === null
      ? ""
      : slugifyBranchSeed(workspace.repoIdentifier.repo);
  if (repoPrefix.length > 0) return repoPrefix;
  return slugifyBranchSeed(workspaceFolderName(workspace.workspacePath));
}
