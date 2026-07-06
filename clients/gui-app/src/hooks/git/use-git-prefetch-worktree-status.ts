import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
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
 *
 * Called once per row across potentially many different worktree hosts (see
 * `GitDiffPanelBodyLive`'s `gitRows.forEach`), so it cannot resolve a single
 * client at hook-render time - `args.hostId` in the request body does not
 * route the call (`HostClient.request()` sends through the bound messenger).
 * Each call resolves its own transient client for `args.hostId` via the host
 * directory, mirroring `useGitListChangedFilesWithSubmodules`. A host with no
 * reachable client is skipped - the same as a disabled query - rather than
 * silently falling back to the app-wide active host.
 */
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
        entry === null ? null : buildTransientHostClient(globalClient, entry);
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
