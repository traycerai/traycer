import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
  WorktreePrState,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";

export type WorktreeDisplayedPrState = "open" | "closed" | "merged";

export interface WorktreePrReference {
  readonly key: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly state: WorktreeDisplayedPrState;
  // The bare PR number, alongside the composed `label`. The sidebar's
  // icon-only variant renders `#<number>` next to a state glyph and has no
  // room for the label's repo prefix / state word, so it needs the raw value
  // rather than parsing it back out of `label`.
  readonly prNumber: number;
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

/**
 * One reference per DETECTED PR across an owner's entries and their submodules.
 *
 * Deduped by `url`, which identifies a pull request uniquely. Two of an owner's
 * running directories can legitimately report the same PR - two worktrees of one
 * repo on the same branch, or two superprojects owning a submodule that is on a
 * PR - and without this they emitted two references carrying the SAME `key`,
 * since the key is built from `prNumber` + `prUrl` and not the directory. That
 * is a duplicate React key wherever these are rendered as a list, and a
 * repeated icon for a single PR either way.
 */
export function worktreePrReferences(
  worktrees: readonly WorktreeHostEntryV12[],
): readonly WorktreePrReference[] {
  const seenUrls = new Set<string>();
  return allWorktreePrReferences(worktrees).filter((reference) => {
    if (seenUrls.has(reference.url)) return false;
    seenUrls.add(reference.url);
    return true;
  });
}

function allWorktreePrReferences(
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
      // Visible label carries no state word - the pill's colored dot encodes
      // it, so repeating "Open" cost width to say the same thing twice. The
      // ARIA label still spells it out: the dot is `aria-hidden`, so this
      // string is the ONLY place a screen reader learns the state.
      label: `${prefix}#${args.prNumber}`,
      ariaLabel: `Open ${prefix}PR #${args.prNumber} ${PR_STATE_LABEL[state]}`,
      state,
      prNumber: args.prNumber,
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
  workspaces: readonly WorktreeWorkspaceSummaryV14[],
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
    const runPath =
      entry.mode === "worktree" && entry.worktreePath !== null
        ? entry.worktreePath
        : entry.workspacePath;
    return {
      key: entry.workspacePath,
      name: entry.repoIdentifier?.repo ?? folderName(entry.workspacePath),
      // Three sources, most-specific first. `entry.branch` is recorded when a
      // WORKTREE binding is created and is null for a plain folder, which is
      // why the workspace summary is the last word: without it a folder the
      // owner runs in directly reads "No branch" however many times it is
      // refreshed, because no amount of refreshing changes a null.
      branch:
        worktree?.branch ??
        entry.branch ??
        workspaceBranch(workspaces, runPath),
      runPath,
      worktree,
    };
  });
}

/**
 * The checked-out branch of a plain folder, read off the workspace summary's
 * own worktree list.
 *
 * Prefers the row whose path IS the run path over the repo's `isMain` row: when
 * the folder the owner runs in is itself a worktree of some other checkout,
 * `isMain` names a different directory on a different branch.
 */
function workspaceBranch(
  workspaces: readonly WorktreeWorkspaceSummaryV14[],
  runPath: string,
): string | null {
  const summary = workspaces.find(
    (candidate) => candidate.workspacePath === runPath,
  );
  if (summary === undefined) return null;
  const exact = summary.worktrees.find(
    (candidate) => candidate.worktreePath === runPath,
  );
  const row = exact ?? summary.worktrees.find((candidate) => candidate.isMain);
  return row?.branch ?? null;
}

function folderName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) ?? path;
}
