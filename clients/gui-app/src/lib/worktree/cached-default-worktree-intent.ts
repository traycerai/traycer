import type { QueryClient } from "@tanstack/react-query";
import type {
  WorktreeIntent,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { resolvePrimaryPath } from "./resolve-primary-path";
import {
  buildDefaultBranchByPath,
  EMPTY_DEFAULT_BRANCH,
} from "./default-branch-name";
import {
  defaultFolderIntent,
  mainCheckoutHasCommit,
} from "./worktree-intent-seeding";

/** Derive the landing launch's unstaged default from this host's cached summaries. */
export function readCachedDefaultWorktreeIntent(
  queryClient: QueryClient,
  hostId: string | null,
  workspace: LandingDraftWorkspaceSnapshot,
): WorktreeIntent | null {
  const response = queryClient.getQueryData<{
    readonly workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV14>;
  }>(
    hostQueryKeys.method<HostRpcRegistry, "worktree.listByWorkspacePaths">(
      hostId,
      "worktree.listByWorkspacePaths",
      {
        workspacePaths: [...workspace.folders],
        scriptRefs: [],
        forceRefresh: false,
      },
    ),
  );
  const summariesByPath = new Map(
    response?.workspaces.map((summary) => [summary.workspacePath, summary]) ??
      [],
  );
  const worktreeDefaults = workspace.folders.flatMap((workspacePath) => {
    const summary = summariesByPath.get(workspacePath);
    if (
      summary === undefined ||
      summary.resolvedAt === null ||
      !summary.isGitRepo
    ) {
      return [];
    }
    const currentBranch = branchForCachedSummary(summary);
    // A detached HEAD or a branch with no commit has no fork source: no default.
    return currentBranch === null || !mainCheckoutHasCommit(summary)
      ? []
      : [{ summary, currentBranch }];
  });
  if (worktreeDefaults.length === 0) return null;

  const defaultBranchByPath = buildDefaultBranchByPath(
    worktreeDefaults.map((entry) => entry.summary),
    worktreeDefaults.length > 1,
    useSettingsStore.getState().worktreeBranchPrefix,
  );
  const primaryPath = resolvePrimaryPath(
    workspace.folders,
    workspace.primaryPath,
  );
  return {
    entries: worktreeDefaults.map(({ summary, currentBranch }) =>
      defaultFolderIntent({
        workspacePath: summary.workspacePath,
        repoIdentifier: summary.repoIdentifier,
        isPrimary: summary.workspacePath === primaryPath,
        isGitRepo: true,
        hasCommit: true,
        currentBranch,
        defaultNewBranchName: (
          defaultBranchByPath[summary.workspacePath] ?? EMPTY_DEFAULT_BRANCH
        ).name,
      }),
    ),
  };
}

function branchForCachedSummary(
  summary: WorktreeWorkspaceSummaryV14,
): string | null {
  const mainEntry = summary.worktrees.find((worktree) => worktree.isMain);
  return mainEntry?.branch ?? summary.mainBranch ?? null;
}
