import type {
  DiskWorktreeEntry,
  WorktreeBranch,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import { stripRemotePrefix } from "@/lib/worktree/strip-remote-prefix";

type RepoIdentifier = WorktreeFolderIntent["repoIdentifier"];

/**
 * The unified branch/worktree picker keeps location choices and source-branch
 * choices separate:
 *
 *  - Existing on-disk worktrees appear under the Location control (→ `import`).
 *  - The New worktree source list shows every branch returned by
 *    `worktree.listBranches`, de-duping the current branch because it is already
 *    represented by the clean current-branch fork row.
 *  - Every New worktree source creates a new branch (`branch.new`). The source
 *    list never performs a direct checkout of an existing branch.
 */
export interface UnifiedPickerModelInput {
  readonly summary: WorktreeWorkspaceSummary;
  readonly branches: ReadonlyArray<WorktreeBranch>;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly defaultNewBranchName: string;
  /**
   * Distinct paths from `git status --porcelain` on the main checkout. A dirty
   * tree (`> 0`) is what unlocks the "Working tree · <branch>" carry source above
   * the clean current-branch fork; a clean tree has nothing to carry.
   */
  readonly uncommittedFileCount: number;
}

export interface UnifiedPickerWorktreeRow {
  readonly id: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly sourceBranch: string | null;
  readonly isLocked: boolean;
  readonly selected: boolean;
  readonly intent: WorktreeFolderIntent;
}

export interface UnifiedPickerSourceOption {
  /**
   * Stable selection identity. Equals `name` for every source EXCEPT the
   * working-tree carry source, which shares the current branch's `name` with the
   * clean fork and so needs a distinct id ({@link WORKING_TREE_SOURCE_ID}).
   */
  readonly id: string;
  /** The branch this forks from (→ `branch.source` and secondary source context). */
  readonly name: string;
  readonly label: string;
  /** Snapshots the source's uncommitted WIP into the new worktree. Only ever
   * true for the working-tree carry source. */
  readonly carryUncommittedChanges: boolean;
  /** Drives the "remote" badge; a remote-only ref always forks a local branch. */
  readonly isRemote: boolean;
  readonly defaultNewBranchName: string;
}

export interface UnifiedPickerModel {
  /** The branch checked out at the workspace folder itself (the main worktree). */
  readonly currentBranch: string | null;
  /** Full source list for the "New worktree" form's source selector, ordered:
   * working-tree carry (dirty only), clean current-branch fork, then branches. */
  readonly sourceOptions: ReadonlyArray<UnifiedPickerSourceOption>;
  /** Default selected source id — the clean current-branch fork, or the prior
   * staged source when re-opening a staged new-worktree intent. */
  readonly newBranchSourceId: string | null;
}

/** Selection id of the working-tree carry source. A `:` is invalid in a git ref,
 * so this can never collide with a branch name. */
export const WORKING_TREE_SOURCE_ID = "working-tree:carry";

export function buildUnifiedPickerModel(
  input: UnifiedPickerModelInput,
): UnifiedPickerModel {
  const mainEntry = input.summary.worktrees.find((w) => w.isMain) ?? null;
  const currentBranch = mainEntry?.branch ?? input.summary.mainBranch ?? null;

  const branchSources = buildBranchSources({
    branches: input.branches,
    currentBranch,
    defaultNewBranchName: input.defaultNewBranchName,
  });

  const sourceOptions = [
    ...currentBranchSourceOptions({
      currentBranch,
      uncommittedFileCount: input.uncommittedFileCount,
      defaultNewBranchName: input.defaultNewBranchName,
    }),
    ...branchSources,
  ];

  const firstBranchSourceId =
    branchSources.length > 0 ? branchSources[0].id : null;

  return {
    currentBranch,
    sourceOptions,
    // Default to the clean current-branch fork (a fresh worktree, no carry); when
    // re-opening a staged new-worktree, the prior source wins; otherwise fall back
    // to the first branch source when there is no current branch.
    newBranchSourceId:
      stagedNewBranchSourceId(input.currentIntent) ??
      currentBranch ??
      firstBranchSourceId,
  };
}

/**
 * The current branch as a New-worktree source in fork-only form: a clean fork
 * always, plus a "Working tree" carry source above it when the tree is dirty
 * (there is WIP to carry).
 */
function currentBranchSourceOptions(input: {
  readonly currentBranch: string | null;
  readonly uncommittedFileCount: number;
  readonly defaultNewBranchName: string;
}): ReadonlyArray<UnifiedPickerSourceOption> {
  if (input.currentBranch === null) return [];
  const fork = currentBranchForkSource(
    input.currentBranch,
    input.defaultNewBranchName,
  );
  if (input.uncommittedFileCount <= 0) return [fork];
  return [
    workingTreeCarrySource(input.currentBranch, input.defaultNewBranchName),
    fork,
  ];
}

/** The source id of a staged new-worktree intent, resolving carry vs clean to
 * the right current-branch id; `null` when nothing matching is staged. */
function stagedNewBranchSourceId(
  currentIntent: WorktreeFolderIntent | null,
): string | null {
  if (currentIntent?.kind !== "worktree") return null;
  const { branch } = currentIntent;
  if (branch.type !== "new") return null;
  return branch.carryUncommittedChanges
    ? WORKING_TREE_SOURCE_ID
    : branch.source;
}

function workingTreeCarrySource(
  currentBranch: string,
  defaultNewBranchName: string,
): UnifiedPickerSourceOption {
  return {
    id: WORKING_TREE_SOURCE_ID,
    name: currentBranch,
    label: `Working tree · ${currentBranch}`,
    carryUncommittedChanges: true,
    isRemote: false,
    defaultNewBranchName,
  };
}

function currentBranchForkSource(
  currentBranch: string,
  defaultNewBranchName: string,
): UnifiedPickerSourceOption {
  return {
    id: currentBranch,
    name: currentBranch,
    label: currentBranch,
    carryUncommittedChanges: false,
    isRemote: false,
    defaultNewBranchName,
  };
}

function buildBranchSources(input: {
  readonly branches: ReadonlyArray<WorktreeBranch>;
  readonly currentBranch: string | null;
  readonly defaultNewBranchName: string;
}): ReadonlyArray<UnifiedPickerSourceOption> {
  const seen = new Set<string>();
  return input.branches
    .flatMap<UnifiedPickerSourceOption>((branch) => {
      if (branch.name === input.currentBranch) return [];
      if (branch.isRemoteOnly) {
        const localName = stripRemotePrefix(branch.name);
        return [
          {
            id: branch.name,
            name: branch.name,
            label: `Remote · ${branch.name}`,
            carryUncommittedChanges: false,
            isRemote: true,
            defaultNewBranchName: localName,
          },
        ];
      }
      return [
        {
          id: branch.name,
          name: branch.name,
          label: branch.name,
          carryUncommittedChanges: false,
          isRemote: false,
          defaultNewBranchName: input.defaultNewBranchName,
        },
      ];
    })
    .filter((option) => {
      if (seen.has(option.name)) return false;
      seen.add(option.name);
      return true;
    });
}

/**
 * The existing-worktree submenu rows for the Location control, built from the
 * summary's sibling worktrees ALONE — no `worktree.listBranches` needed. Each
 * row carries an `import` intent for its disk path, the branch label, and the
 * locked badge.
 * One click adopts the worktree (→ `import`), preserving the partition invariant
 * (existing worktrees are reached only through import, never `git worktree add`).
 */
export function worktreeImportRows(input: {
  readonly workspacePath: string;
  readonly repoIdentifier: RepoIdentifier;
  readonly isPrimary: boolean;
  readonly summary: WorktreeWorkspaceSummary;
  readonly currentIntent: WorktreeFolderIntent | null;
}): ReadonlyArray<UnifiedPickerWorktreeRow> {
  const base = {
    workspacePath: input.workspacePath,
    repoIdentifier: input.repoIdentifier,
    isPrimary: input.isPrimary,
  } as const;
  const intent = input.currentIntent;
  return input.summary.worktrees
    .filter((w) => !w.isMain)
    .map<UnifiedPickerWorktreeRow>((entry: DiskWorktreeEntry) => ({
      id: `worktree:${entry.worktreePath}`,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      sourceBranch: entry.sourceBranch ?? null,
      isLocked: entry.isLocked,
      selected:
        intent?.kind === "import" && intent.worktreePath === entry.worktreePath,
      intent: {
        kind: "import",
        ...base,
        worktreePath: entry.worktreePath,
      },
    }));
}

/** The intent emitted by the "New worktree" form for a source + branch name. */
export function newWorktreeIntent(input: {
  readonly workspacePath: string;
  readonly repoIdentifier: RepoIdentifier;
  readonly isPrimary: boolean;
  readonly source: UnifiedPickerSourceOption;
  readonly branchName: string;
}): WorktreeFolderIntent | null {
  const branchName = input.branchName.trim();
  if (branchName.length === 0) return null;
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: input.workspacePath,
    repoIdentifier: input.repoIdentifier,
    isPrimary: input.isPrimary,
    branch: {
      type: "new",
      name: branchName,
      source: input.source.name,
      carryUncommittedChanges: input.source.carryUncommittedChanges,
    },
  };
}
