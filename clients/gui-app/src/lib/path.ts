export function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex === -1) return trimmed;
  return trimmed.slice(slashIndex + 1);
}

export function dirnameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex === -1) return "";
  return trimmed.slice(0, slashIndex);
}

/**
 * A path decomposed for the @mention preview's breadcrumb tree: the leaf
 * (file/folder/worktree-dir name) plus its nearest ancestor directories,
 * split into a `rootLabel` (the absorbed deeper prefix, "" when the leaf
 * sits at the root) and up to 2 `midDirs` rows - so the tree never exceeds
 * 4 rows regardless of how deep the path goes.
 */
export type MentionPathTree = {
  readonly rootLabel: string;
  readonly midDirs: readonly string[];
  readonly leaf: string;
  readonly leafIsFile: boolean;
};

/**
 * Splits `path` into a breadcrumb tree: leaf + its up-to-3 nearest ancestor
 * directories, with everything deeper absorbed into `rootLabel` as one
 * relative-path string; `midDirs` holds the 1-2 rows in between. `path` may
 * be workspace-relative (file/folder) or absolute (worktree, which lives
 * outside the workspace root) - an absolute input keeps its leading `/` on
 * `rootLabel` (or on `leaf` when there are no directory rows to carry it) so
 * the tree still reads as an absolute path.
 */
export function mentionPathTree(
  path: string,
  leafIsFile: boolean,
): MentionPathTree {
  const trimmed = path.replace(/\/+$/, "");
  const isAbsolute = trimmed.startsWith("/");
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { rootLabel: "", midDirs: [], leaf: "", leafIsFile };
  }
  const leafSegment = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const topIndex = Math.max(0, dirs.length - 3);
  const rootDirs = dirs.slice(0, topIndex + 1);
  const rootLabel =
    rootDirs.length === 0
      ? ""
      : `${isAbsolute ? "/" : ""}${rootDirs.join("/")}`;
  const midDirs = dirs.slice(topIndex + 1);
  // With no directory rows, rootLabel is "" and nothing else carries the
  // absolute marker - fold it onto the leaf instead so a single-segment
  // absolute path (e.g. a worktree mounted at "/repo") doesn't render
  // identically to a relative dir named "repo".
  const leaf =
    isAbsolute && dirs.length === 0 ? `/${leafSegment}` : leafSegment;
  return { rootLabel, midDirs, leaf, leafIsFile };
}
