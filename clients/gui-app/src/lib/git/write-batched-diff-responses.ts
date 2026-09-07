import type { QueryClient } from "@tanstack/react-query";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitGetFileDiffResponse,
  type GitStage,
} from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

interface BatchedDiffRequestFile {
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
}

export function writeBatchedDiffResponses(args: {
  queryClient: QueryClient;
  hostId: string;
  runningDir: string;
  requestFiles: ReadonlyArray<BatchedDiffRequestFile>;
  ignoreWhitespace: boolean;
  diffs: ReadonlyArray<GitGetFileDiffResponse>;
}): void {
  // Each response.diffs[i] is the host's diff for that file; key by request path/stage plus response OIDs.

  for (const [index, diff] of args.diffs.entries()) {
    if (index >= args.requestFiles.length) {
      continue;
    }

    const requestFile = args.requestFiles[index];
    const correctedKey = gitQueryKeys.fileDiff(
      args.hostId,
      args.runningDir,
      requestFile.filePath,
      requestFile.previousPath,
      requestFile.stage,
      diff.headSha,
      diff.stagedOid,
      diff.worktreeOid,
      args.ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    args.queryClient.setQueryData(correctedKey, diff);
  }
}
