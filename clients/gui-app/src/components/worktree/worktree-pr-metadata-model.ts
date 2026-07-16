import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
  WorktreePrState,
} from "@traycer/protocol/host/worktree-schemas";

export type WorktreeDisplayedPrState = "open" | "closed" | "merged";

export interface WorktreePrReference {
  readonly key: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly state: WorktreeDisplayedPrState;
  readonly url: string;
  readonly branch: string | null;
  readonly worktreePath: string;
}

export interface OwnerWorkspaceMetadataItem {
  readonly key: string;
  readonly name: string;
  readonly branch: string | null;
  readonly runPath: string;
  readonly worktree: WorktreeHostEntryV12 | null;
}

const PR_STATE_LABEL: Record<WorktreeDisplayedPrState, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

export function worktreePrReferences(
  worktrees: readonly WorktreeHostEntryV12[],
): readonly WorktreePrReference[] {
  return worktrees.flatMap((entry) => {
    const superproject = prReference({
      keyPrefix: "worktree",
      repoLabel: null,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      prState: entry.prState,
      prNumber: entry.prNumber,
      prUrl: entry.prUrl,
    });
    const submodules = entry.submodules.flatMap((submodule) =>
      prReference({
        keyPrefix: `submodule:${submodule.repoIdentifier.owner}/${submodule.repoIdentifier.repo}`,
        repoLabel: submodule.repoIdentifier.repo,
        branch: submodule.branch,
        worktreePath: entry.worktreePath,
        prState: submodule.prState,
        prNumber: submodule.prNumber,
        prUrl: submodule.prUrl,
      }),
    );
    return [...superproject, ...submodules];
  });
}

function prReference(args: {
  readonly keyPrefix: string;
  readonly repoLabel: string | null;
  readonly branch: string | null;
  readonly worktreePath: string;
  readonly prState: WorktreePrState | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
}): readonly WorktreePrReference[] {
  const state = displayedPrState(args.prState);
  if (state === null || args.prNumber === null || args.prUrl === null)
    return [];
  const prefix = args.repoLabel === null ? "" : `${args.repoLabel} `;
  return [
    {
      key: `${args.keyPrefix}:${args.prNumber}:${args.prUrl}`,
      label: `${prefix}#${args.prNumber} ${PR_STATE_LABEL[state]}`,
      ariaLabel: `Open ${prefix}PR #${args.prNumber} ${PR_STATE_LABEL[state]}`,
      state,
      url: args.prUrl,
      branch: args.branch,
      worktreePath: args.worktreePath,
    },
  ];
}

function displayedPrState(
  state: WorktreePrState | null,
): WorktreeDisplayedPrState | null {
  return state === "open" || state === "closed" || state === "merged"
    ? state
    : null;
}

export function ownerWorkspaceMetadataItems(
  binding: WorktreeBinding | null,
  worktrees: readonly WorktreeHostEntryV12[],
): readonly OwnerWorkspaceMetadataItem[] {
  if (binding === null) return [];
  const worktreesByPath = new Map(
    worktrees.map((worktree) => [worktree.worktreePath, worktree]),
  );
  return binding.entries.map((entry) => {
    const worktree =
      entry.worktreePath === null
        ? null
        : (worktreesByPath.get(entry.worktreePath) ?? null);
    return {
      key: entry.workspacePath,
      name: entry.repoIdentifier?.repo ?? folderName(entry.workspacePath),
      branch: worktree?.branch ?? entry.branch,
      runPath:
        entry.mode === "worktree" && entry.worktreePath !== null
          ? entry.worktreePath
          : entry.workspacePath,
      worktree,
    };
  });
}

function folderName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) ?? path;
}
