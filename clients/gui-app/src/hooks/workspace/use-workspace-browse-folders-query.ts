import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * One level of the host filesystem for the remote folder picker
 * (`workspace.browseFolders`). `directoryPath: null` lists the host's browse
 * roots (the user's home directory). Each level is its own cache entry, so
 * drilling back up re-renders instantly from cache.
 *
 * The client is the REQUESTER's (tab-bound where the pick started in a tab) -
 * this hook must not resolve the app-wide active host itself, or the picker
 * could browse a different machine than the one the picked path is sent to.
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
