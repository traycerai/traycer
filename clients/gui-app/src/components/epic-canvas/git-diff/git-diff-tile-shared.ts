import type { GitChangedFile } from "@traycer/protocol/host";
import type {
  GitDiffBundleTilePayload,
  GitDiffFileTilePayload,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";

export type GitFileDiffTileRef = Omit<GitDiffTileRef, "diff"> & {
  readonly diff: GitDiffFileTilePayload;
};

export type GitBundleDiffTileRef = Omit<GitDiffTileRef, "diff"> & {
  readonly diff: GitDiffBundleTilePayload;
};

// Find coverage messages shared between the single-file panel and the bundle
// find machinery. Co-located so both surfaces describe partial coverage with
// identical copy.
export const GIT_DIFF_LOADING_FIND_MESSAGE = "Diff content is still loading.";
export const GIT_DIFF_MISSING_FIND_MESSAGE = "This file is no longer changed.";
export const GIT_DIFF_BINARY_FIND_MESSAGE =
  "Binary diff content is unavailable; only file metadata was searched.";
export const GIT_DIFF_ERROR_FIND_MESSAGE = "Diff content is unavailable.";
export const GIT_DIFF_TRUNCATED_FIND_MESSAGE =
  "Only the loaded portion of this truncated diff was searched.";
export const GIT_BUNDLE_DIFF_LOADING_FIND_MESSAGE =
  "Bundle diff content is still loading.";

// Identity of a "load the full diff" request for a single file. Shared so the
// single-file panel and a bundle's inline section compute the cache identity
// the same way before flipping the byte budget off.
export function fileDiffLoadFullIdentity(args: {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitChangedFile["stage"];
  readonly headSha: string;
  readonly stagedOid: string | null;
  readonly worktreeOid: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([
    args.runningDir,
    args.filePath,
    args.previousPath,
    args.stage,
    args.headSha,
    args.stagedOid,
    args.worktreeOid,
    args.ignoreWhitespace,
  ]);
}
