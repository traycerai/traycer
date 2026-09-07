import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Client is the requester's. Do not resolve the app-wide active host or the picker can browse a different machine than the one the picked path is sent to.
 */
export function useWorkspaceBrowseFolders(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly directoryPath: string | null;
  readonly enabled: boolean;
}) {
  const params = useMemo(
    () => ({ directoryPath: args.directoryPath }),
    [args.directoryPath],
  );
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "workspace.browseFolders",
    params,
    options: {
      enabled: args.enabled,
      staleTime: 10_000,
      // Never auto-retry: a timed-out listing is parked on a host threadpool
      // worker until the OS answers, and each automatic retry of a DIFFERENT
      // path could start another. The picker offers manual Retry instead.
      retry: false,
    },
  });
}
