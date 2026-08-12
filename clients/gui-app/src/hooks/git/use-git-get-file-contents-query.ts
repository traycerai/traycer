import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitStage, HostRpcRegistry } from "@traycer/protocol/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useGitGetFileContentsQuery(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "git.getFileContents">,
  HostRpcError
> {
  const params = useMemo(
    () => ({
      hostId: args.hostId,
      runningDir: args.runningDir,
      filePath: args.filePath,
      previousPath: args.previousPath,
      stage: args.stage,
    }),
    [
      args.filePath,
      args.hostId,
      args.previousPath,
      args.runningDir,
      args.stage,
    ],
  );
  return useHostQuery<HostRpcRegistry, "git.getFileContents">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "git.getFileContents",
    params,
    options: {
      enabled: args.enabled,
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,
    },
  });
}
