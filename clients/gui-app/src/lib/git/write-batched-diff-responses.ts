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
  // Authorization: CLAUDE.md "response-equals-state" carve-out (Q20).
  // Each response.diffs[i] is the host's authoritative diff for that file at
  // the response's OIDs. Writing it into the cache is fan-out of one wire
  // response into N slots that would otherwise require N round-trips.
  //
  // Key construction uses request-side identity plus response-side OIDs. The
  // path/stage must match subscribers, while OIDs must reflect host state to
  // defeat the invalidate-then-overwrite race documented in Q20 + ADR-0004.

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
