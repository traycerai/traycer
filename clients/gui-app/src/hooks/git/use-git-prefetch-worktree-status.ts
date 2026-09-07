import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";

/** Resolve a transient client for args.hostId per call. hostId in the body does not route. Skip undialable hosts. */
export function useGitPrefetchWorktreeStatus() {
  const globalClient = useHostClient();
  const directory = useHostDirectory();
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

      const entry = directory.findById(args.hostId);
      const client =
        entry === null ? null : buildDialableHostClient(globalClient, entry);
      if (client === null) {
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
    [directory, globalClient, queryClient],
  );
}
