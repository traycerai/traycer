import Fuse, { type IFuseOptions } from "fuse.js";
import type { GitChangedFile } from "@traycer/protocol/host";
import { NO_HIGHLIGHT, type HighlightRanges } from "@/lib/git/path-highlight";

export interface GitChangedFileMatch {
  readonly file: GitChangedFile;
  /** Match ranges into `file.path` for highlighting (empty when only the
   * previous path matched, e.g. a rename found by its old name). */
  readonly pathRanges: HighlightRanges;
}

// Tuned to match the other fuse.js usages in this app
// (worktree-branch-search.ts, harness-model-search.ts): location-agnostic so a
// match anywhere in the path counts, with a moderate fuzzy threshold. The
// current path is weighted above the previous (rename) path.
const GIT_CHANGED_FILE_FUSE_OPTIONS: IFuseOptions<GitChangedFile> = {
  includeScore: false,
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [
    { name: "path", weight: 0.8 },
    { name: "previousPath", weight: 0.2 },
  ],
};

export function createGitChangedFileSearchIndex(
  files: ReadonlyArray<GitChangedFile>,
): Fuse<GitChangedFile> {
  return new Fuse([...files], GIT_CHANGED_FILE_FUSE_OPTIONS);
}

/**
 * Fuzzy-filter the Git panel's changed-file list. An empty query
 * returns every file (with no highlight); otherwise it returns the fuse.js
 * matches paired with the ranges that hit the displayed `path`. Callers re-sort
 * the result, so the fuse relevance order is not relied upon here.
 */
export function filterGitChangedFiles(
  files: ReadonlyArray<GitChangedFile>,
  searchIndex: Fuse<GitChangedFile>,
  query: string,
): ReadonlyArray<GitChangedFileMatch> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return files.map((file) => ({ file, pathRanges: NO_HIGHLIGHT }));
  }
  return searchIndex.search(trimmed).map((result) => {
    const pathMatch = result.matches?.find((match) => match.key === "path");
    return {
      file: result.item,
      pathRanges: pathMatch === undefined ? NO_HIGHLIGHT : pathMatch.indices,
    };
  });
}
