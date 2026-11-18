import type { QueryClient } from "@tanstack/react-query";
import type { GitListChangedFilesResponse } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

export function writeGitListChangedFilesResponse(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly runningDir: string;
    readonly ignoreWhitespace: boolean;
  },
  response: GitListChangedFilesResponse,
): void {
  queryClient.setQueryData(
    gitQueryKeys.listChangedFiles(
      args.hostId,
      args.runningDir,
      args.ignoreWhitespace,
    ),
    response,
  );
}
