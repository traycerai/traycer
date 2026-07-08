import type { QueryClient } from "@tanstack/react-query";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

/**
 * Manual refresh of the active root's nested `git.listChangedFiles@1.1` slot
 * (the panel's source of truth for parent files + submodules). Shared by the
 * panel toolbar refresh and the reference-row refresh so both surfaces bust
 * the same cache slot.
 */
export function invalidateGitSubmoduleSnapshot(
  queryClient: QueryClient,
  args: {
    readonly hostId: string;
    readonly rootRunningDir: string;
    readonly ignoreWhitespace: boolean;
  },
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: gitQueryKeys.listChangedFilesWithSubmodules(
      args.hostId,
      args.rootRunningDir,
      args.ignoreWhitespace,
    ),
  });
}
