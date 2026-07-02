import type { QueryClient } from "@tanstack/react-query";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";

/**
 * Writes a `git.listChangedFiles@1.1` nested snapshot into its cache slot, and
 * mirrors the parent changeset into the frozen v1.0 slot the subscription and
 * worktree picker read.
 *
 * The v1.1 response is a structural superset of v1.0 (its parent `files` extend
 * the v1.0 file shape and it adds `submodules`), so the same object serves both
 * slots: v1.0 consumers ignore the extra fields. Mirroring keeps the picker's
 * change-count and the single-repo fallback view fresh on a manual refresh
 * without a second RPC.
 *
 * Response-equals-state carve-out (per CLAUDE.md): the RPC response directly
 * reifies the change-list UI state without transformation.
 */
export function writeGitListChangedFilesWithSubmodulesResponse(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly runningDir: string;
    readonly ignoreWhitespace: boolean;
  },
  response: GitListChangedFilesResponseV11,
): void {
  queryClient.setQueryData(
    gitQueryKeys.listChangedFilesWithSubmodules(
      args.hostId,
      args.runningDir,
      args.ignoreWhitespace,
    ),
    response,
  );
  writeGitListChangedFilesResponse(queryClient, args, response);
}
