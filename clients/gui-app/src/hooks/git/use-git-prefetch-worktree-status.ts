import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient } from "@/lib/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";

/**
 * Single-shot prefetch for git.listChangedFiles per (hostId, runningDir, ignoreWhitespace).
 * Populates the same cache slot as the subscription would, so rows read the cached
 * parent status via queryClient.getQueryData without opening N streams.
 *
 * Response written to cache per Q20 lock (response-equals-state carve-out):
 * listChangedFiles RPC is the parent-level status source for the picker badges;
 * the UI projects it into typed file/module counts at the panel boundary.
 */
export function useGitPrefetchWorktreeStatus() {
  const client = useHostClient();
  const queryClient = useQueryClient();

  return useCallback(
    async (args: {
      hostId: string;
      runningDir: string;
      ignoreWhitespace: boolean;
    }) => {
      const key = gitQueryKeys.listChangedFiles(
        args.hostId,
        args.runningDir,
        args.ignoreWhitespace,
      );

      // Early exit if already cached
      if (queryClient.getQueryData(key) !== undefined) {
        return;
      }

      // Parent-only: the badge/default-pick prefetch must never trigger the
      // host's per-submodule git-status fan-out (bounded lazy fan-out - only
      // the active root's nested snapshot asks for submodules).
      const result = await client.request("git.listChangedFiles", {
        hostId: args.hostId,
        runningDir: args.runningDir,
        ignoreWhitespace: args.ignoreWhitespace,
        includeSubmodules: false,
      });

      writeGitListChangedFilesResponse(
        queryClient,
        {
          hostId: args.hostId,
          runningDir: args.runningDir,
          ignoreWhitespace: args.ignoreWhitespace,
        },
        result,
      );
    },
    [client, queryClient],
  );
}
