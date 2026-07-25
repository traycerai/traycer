import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import type { GitSubmoduleSummary } from "@/lib/git/git-repo-tree";
import { getBasename } from "@/lib/path/cross-platform-path";
import { formatWorktreeFolderDisabledReason } from "@/lib/worktree/worktree-folder-disabled-reason";
import { isWorkspaceResolvePending } from "@/lib/worktree/worktree-row-resolve-pending";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";

export interface GitDiffRepoSelection {
  readonly hostId: string;
  readonly rootRunningDir: string;
  readonly repoRoot: string;
}

export interface GitDiffRepoSwitcherRootCounts {
  readonly fileChangeCount: number | null;
  readonly moduleChangeCount: number | null;
}

export interface GitDiffRepoSwitcherRootInput extends GitDiffRepoSwitcherRootCounts {
  readonly row: WorktreeBindingSelectorRowV12;
}

export interface GitDiffRepoSwitcherInput {
  readonly roots: ReadonlyArray<GitDiffRepoSwitcherRootInput>;
  readonly activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>;
  readonly selected: GitDiffRepoSelection | null;
  readonly searchQuery: string;
}

export interface GitDiffRepoSwitcherTriggerModel {
  readonly label: string;
  readonly secondaryLabel: string;
  readonly fileChangeCount: number | null;
  readonly moduleChangeCount: number | null;
  readonly unavailable: boolean;
  readonly openTarget: {
    readonly workspacePath: string;
    readonly hostId: string;
  } | null;
}

export interface GitDiffRepoSwitcherRootRow {
  readonly kind: "root";
  readonly key: string;
  readonly row: WorktreeBindingSelectorRowV12;
  readonly label: string;
  readonly secondaryLabel: string;
  readonly headLabel: string | null;
  readonly fileChangeCount: number | null;
  readonly moduleChangeCount: number | null;
  readonly selected: boolean;
  readonly disabledLabel: string | null;
  /** Disabled only by unverified facts: render muted "checking", not an error. */
  readonly pending: boolean;
  readonly unavailable: false;
  readonly clean: boolean;
  readonly depth: 0;
  readonly searchText: string;
}
export type GitDiffRepoSwitcherRow = GitDiffRepoSwitcherRootRow;

export interface GitDiffRepoSwitcherModel {
  readonly trigger: GitDiffRepoSwitcherTriggerModel;
  readonly rows: ReadonlyArray<GitDiffRepoSwitcherRow>;
  readonly visibleRows: ReadonlyArray<GitDiffRepoSwitcherRow>;
}

function rootLabel(row: WorktreeBindingSelectorRowV12): string {
  return row.repoIdentifier?.repo ?? getBasename(row.runningDir);
}

function rootDisabledLabel(
  row: WorktreeBindingSelectorRowV12,
  pending: boolean,
): string | null {
  // Unverified placeholder facts (cold resolve on the host still in flight):
  // "checking" instead of the lying "not git" / "missing" - the host's sweep
  // pushes the resolved row and this converges on the refetch. `pending` is
  // computed once by the caller so the row's `pending` flag and this label
  // cannot disagree.
  if (pending) return "checking";
  if (!row.isGitRepo) return "not git";
  return formatWorktreeFolderDisabledReason(row);
}

function searchableText(parts: ReadonlyArray<string | null>): string {
  return parts
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ")
    .toLowerCase();
}

function rootSearchText(
  row: WorktreeBindingSelectorRowV12,
  label: string,
  disabledLabel: string | null,
): string {
  return searchableText([
    label,
    row.repoIdentifier?.owner ?? null,
    row.branch,
    row.runningDir,
    row.workspacePath,
    row.worktreePath,
    disabledLabel,
  ]);
}

function submoduleSearchText(args: {
  readonly node: GitSubmoduleSummary;
  readonly repoName: string;
  readonly rootRow: WorktreeBindingSelectorRowV12;
  readonly rootLabel: string;
}): string {
  return searchableText([
    args.node.label,
    args.repoName,
    args.node.headLabel,
    args.node.parentPath,
    args.node.repoRoot,
    args.node.unavailable ? "submodule status unavailable unavailable" : null,
    args.node.hasChanges ? "changed dirty" : "clean",
    args.rootLabel,
    args.rootRow.runningDir,
    args.rootRow.workspacePath,
  ]);
}

function rootSubmodules(
  row: WorktreeBindingSelectorRowV12,
  activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>,
  selected: GitDiffRepoSelection | null,
): ReadonlyArray<GitSubmoduleSummary> {
  return isActiveRoot(row, selected) ? activeRootSubmodules : [];
}

function sumSubmoduleFileChanges(
  submodules: ReadonlyArray<GitSubmoduleSummary>,
): number {
  return submodules.reduce((total, node) => total + node.changeCount, 0);
}

function addKnownCounts(
  primary: number | null,
  secondary: number,
): number | null {
  if (primary === null && secondary === 0) return null;
  return (primary ?? 0) + secondary;
}

function buildRootRow(
  input: GitDiffRepoSwitcherRootInput,
  activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>,
  selected: GitDiffRepoSelection | null,
): GitDiffRepoSwitcherRootRow {
  const label = rootLabel(input.row);
  const pending = isWorkspaceResolvePending(input.row);
  const disabledLabel = rootDisabledLabel(input.row, pending);
  const submodules = rootSubmodules(input.row, activeRootSubmodules, selected);
  const fileChangeCount = input.fileChangeCount;
  const moduleChangeCount = input.moduleChangeCount;
  const submoduleSearch = submodules.map((node) =>
    submoduleSearchText({
      node,
      repoName: getBasename(node.parentPath),
      rootRow: input.row,
      rootLabel: label,
    }),
  );
  const submoduleStateChanged = submodules.some(
    (node) => node.hasChanges || node.unavailable,
  );
  const selectedRoot =
    selected !== null &&
    selected.hostId === input.row.hostId &&
    selected.rootRunningDir === input.row.runningDir;
  const submoduleFileChangeCount = sumSubmoduleFileChanges(submodules);
  return {
    kind: "root",
    key: `root:${worktreeRowKey(input.row)}`,
    row: input.row,
    label,
    secondaryLabel: input.row.runningDir,
    headLabel: input.row.branch,
    fileChangeCount: selectedRoot
      ? addKnownCounts(fileChangeCount, submoduleFileChangeCount)
      : fileChangeCount,
    moduleChangeCount,
    selected: selectedRoot,
    disabledLabel,
    pending,
    unavailable: false,
    clean:
      disabledLabel === null &&
      fileChangeCount === 0 &&
      moduleChangeCount === 0 &&
      !submoduleStateChanged,
    depth: 0,
    searchText: searchableText([
      rootSearchText(input.row, label, disabledLabel),
      ...submoduleSearch,
    ]),
  };
}

function isActiveRoot(
  row: WorktreeBindingSelectorRowV12,
  selected: GitDiffRepoSelection | null,
): boolean {
  return (
    selected !== null &&
    selected.hostId === row.hostId &&
    selected.rootRunningDir === row.runningDir
  );
}

function buildRows(
  roots: ReadonlyArray<GitDiffRepoSwitcherRootInput>,
  activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>,
  selected: GitDiffRepoSelection | null,
): ReadonlyArray<GitDiffRepoSwitcherRow> {
  return roots.map((root) =>
    buildRootRow(root, activeRootSubmodules, selected),
  );
}

function filterRows(
  rows: ReadonlyArray<GitDiffRepoSwitcherRow>,
  searchQuery: string,
): ReadonlyArray<GitDiffRepoSwitcherRow> {
  const query = searchQuery.trim().toLowerCase();
  if (query.length === 0) return rows;
  return rows.filter((row) => row.searchText.includes(query));
}

function selectedRootInput(
  roots: ReadonlyArray<GitDiffRepoSwitcherRootInput>,
  selected: GitDiffRepoSelection | null,
): GitDiffRepoSwitcherRootInput | null {
  if (selected === null) return null;
  return (
    roots.find(
      (root) =>
        root.row.hostId === selected.hostId &&
        root.row.runningDir === selected.rootRunningDir,
    ) ?? null
  );
}

function buildTrigger(
  roots: ReadonlyArray<GitDiffRepoSwitcherRootInput>,
  rows: ReadonlyArray<GitDiffRepoSwitcherRow>,
  activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>,
  selected: GitDiffRepoSelection | null,
): GitDiffRepoSwitcherTriggerModel {
  if (selected === null) {
    return {
      label: "Select workspace",
      secondaryLabel: "Choose a bound workspace",
      fileChangeCount: null,
      moduleChangeCount: null,
      unavailable: false,
      openTarget: null,
    };
  }

  const root = selectedRootInput(roots, selected);
  if (root === null) {
    return {
      label: "Workspace unavailable",
      secondaryLabel: selected.rootRunningDir,
      fileChangeCount: null,
      moduleChangeCount: null,
      unavailable: true,
      openTarget: {
        workspacePath: selected.rootRunningDir,
        hostId: selected.hostId,
      },
    };
  }

  const row = rows.find(
    (item) => item.key === `root:${worktreeRowKey(root.row)}`,
  );
  const submodules = rootSubmodules(root.row, activeRootSubmodules, selected);

  return {
    label: rootLabel(root.row),
    secondaryLabel: root.row.runningDir,
    fileChangeCount:
      row?.fileChangeCount ??
      addKnownCounts(root.fileChangeCount, sumSubmoduleFileChanges(submodules)),
    moduleChangeCount: row?.moduleChangeCount ?? root.moduleChangeCount,
    unavailable: false,
    openTarget: {
      workspacePath: root.row.runningDir,
      hostId: root.row.hostId,
    },
  };
}

export function buildGitDiffRepoSwitcherModel(
  input: GitDiffRepoSwitcherInput,
): GitDiffRepoSwitcherModel {
  const rows = buildRows(
    input.roots,
    input.activeRootSubmodules,
    input.selected,
  );
  return {
    trigger: buildTrigger(
      input.roots,
      rows,
      input.activeRootSubmodules,
      input.selected,
    ),
    rows,
    visibleRows: filterRows(rows, input.searchQuery),
  };
}
