import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  GitGetFileDiffRequest,
  GitGetFileDiffResponse,
  GitStage,
} from "@traycer/protocol/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

/**
 * `client` is the CALLER's, and it must be the one that addresses `args.hostId`
 * - the tile's tab client, never the app-wide one (D15). This hook used to read
 * `useHostClient()` here while taking `hostId` as an argument and asserting the
 * two were "correlated 1:1"; they were not. `hostId` came from the tile and the
 * client from the app, so a diff tile bound to host A kept its A-shaped query
 * key while the request went to whichever host the app was pointed at.
 */
export function useGitGetFileDiffQuery(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
  readonly headSha: string;
  readonly stagedOid: string | null;
  readonly worktreeOid: string | null;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number | null;
  readonly enabled: boolean;
}): UseQueryResult<GitGetFileDiffResponse, HostRpcError> {
  const { client } = args;
  const readiness = useReactiveHostReadiness(client);

  const enabledFromArgs = args.enabled && args.hostId !== null;

  return useQuery({
    // The caller passes the client that addresses `args.hostId`, which is
    // already captured in the key via `hostQueryKeys.scope(hostId)`; including
    // `client` here would cause needless refetches on client identity drift.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<GitGetFileDiffResponse, HostRpcError>({
      queryKey: [
        ...gitQueryKeys.fileDiff(
          args.hostId,
          args.runningDir,
          args.filePath,
          args.previousPath,
          args.stage,
          args.headSha,
          args.stagedOid,
          args.worktreeOid,
          args.ignoreWhitespace,
          args.byteBudget,
        ),
      ],
      queryFn: () =>
        withHostQueryErrorBoundary("git.getFileDiff", async () => {
          // client is captured from closure. enabled: readiness.isReady ensures it's available.
          // The enabled flag prevents this queryFn from running when client is unavailable,
          // but a defensive runtime guard is retained against future refactors.
          if (client === null) {
            // A `HostRpcError` (not a bare Error): this query publicly declares
            // that error type and UI surfaces read `.code`.
            throw hostClientUnavailableError("git.getFileDiff");
          }
          const request: GitGetFileDiffRequest = {
            hostId: args.hostId ?? "",
            runningDir: args.runningDir,
            filePath: args.filePath,
            previousPath: args.previousPath,
            stage: args.stage,
            ignoreWhitespace: args.ignoreWhitespace,
            byteBudget: args.byteBudget,
          };
          return client.request("git.getFileDiff", request);
        }),
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,
    }),
    enabled: enabledFromArgs && readiness.isReady,
  });
}
