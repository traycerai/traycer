import Fuse, { type IFuseOptions } from "fuse.js";

export interface WorktreeBranchSearchRow {
  readonly id: string;
  readonly searchBranch: string;
  readonly searchPathTail: string;
  readonly searchPathBasename: string;
  readonly searchFullPath: string;
}

const WORKTREE_BRANCH_FUSE_OPTIONS: IFuseOptions<WorktreeBranchSearchRow> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [
    { name: "searchBranch", weight: 0.58 },
    { name: "searchPathTail", weight: 0.24 },
    { name: "searchPathBasename", weight: 0.12 },
    { name: "searchFullPath", weight: 0.06 },
  ],
};

export function createWorktreeBranchSearchIndex<
  TRow extends WorktreeBranchSearchRow,
>(rows: ReadonlyArray<TRow>): Fuse<TRow> {
  return new Fuse(rows, WORKTREE_BRANCH_FUSE_OPTIONS);
}

export function filterWorktreeBranchRows<TRow extends WorktreeBranchSearchRow>(
  rows: ReadonlyArray<TRow>,
  searchIndex: Fuse<TRow>,
  query: string,
): ReadonlyArray<TRow> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return rows;
  return searchIndex.search(trimmed).map((result) => result.item);
}

export function pathSearchBasename(path: string): string {
  const segments = pathSegments(path);
  return segments.at(-1) ?? path;
}

export function pathSearchTail(path: string): string {
  const segments = pathSegments(path);
  if (segments.length === 0) return path;
  return segments.slice(Math.max(0, segments.length - 3)).join("/");
}

function pathSegments(path: string): ReadonlyArray<string> {
  return path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
}
