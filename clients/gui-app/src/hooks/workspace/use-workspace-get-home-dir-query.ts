import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorkspacePrepareFoldersRequestV12 } from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Constant params, so the object is hoisted rather than memoized. */
const GET_HOME_DIR_PARAMS: WorkspacePrepareFoldersRequestV12 = {
  operation: "getHomeDir",
  folderPaths: null,
  path: null,
  bumpRecency: null,
};

/**
 * Fallback home for `~` when browse fails. Fails closed with `DOWNGRADE_UNSUPPORTED` on a v1.0 host. An unlistable home still expands.
 */
export function useWorkspaceGetHomeDir(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}) {
  return useHostQuery<HostRpcRegistry, "workspace.prepareFolders">({
    client: args.client,
    method: "workspace.prepareFolders",
    params: GET_HOME_DIR_PARAMS,
    cacheKeyIdentity: undefined,
    options: {
      enabled: args.enabled,
      // Host identity is already part of the key, and availability recovery
      // invalidates host-scoped queries. A home path does not otherwise age.
      staleTime: Infinity,
      retry: false,
    },
  });
}
