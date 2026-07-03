import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient } from "@/lib/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";

/**
 * Single-shot prefetch for git.listChangedFiles per (hostId, runningDir, ignoreWhitespace).
 * Populates the same cache slot as the subscription would, so rows read the cached
 * change count via queryClient.getQueryData without opening N streams.
 *
 * Response written to cache per Q20 lock (response-equals-state carve-out):
 * listChangedFiles RPC directly reifies the picker's change-count badge; no
 * derivation or projection - the response shape matches the UI state exactly.
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

      const result = await client.request("git.listChangedFiles", {
        hostId: args.hostId,
        runningDir: args.runningDir,
        ignoreWhitespace: args.ignoreWhitespace,
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
