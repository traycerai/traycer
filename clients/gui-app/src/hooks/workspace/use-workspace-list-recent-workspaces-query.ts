import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorkspacePrepareFoldersRequestV12 } from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Constant params, so the object is hoisted rather than memoized. */
export const LIST_RECENT_WORKSPACES_PARAMS: WorkspacePrepareFoldersRequestV12 =
  {
    operation: "listRecentWorkspaces",
    folderPaths: null,
    path: null,
    bumpRecency: null,
  };

export function recentWorkspacesQueryKey(hostId: string | null) {
  return hostQueryKeys.method<HostRpcRegistry, "workspace.prepareFolders">(
    hostId,
    "workspace.prepareFolders",
    LIST_RECENT_WORKSPACES_PARAMS,
  );
}

/**
 * Recents fail closed with `DOWNGRADE_UNSUPPORTED` on v1.0; do not surface that error and do not retry. Client is the requester's, matching browse.
 */
export function useWorkspaceListRecentWorkspaces(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}) {
  return useHostQuery<HostRpcRegistry, "workspace.prepareFolders">({
    client: args.client,
    method: "workspace.prepareFolders",
    params: LIST_RECENT_WORKSPACES_PARAMS,
    cacheKeyIdentity: undefined,
    options: {
      enabled: args.enabled,
      // Successful writes update this exact cache from the host's returned
      // order. Keep rapid reopenings local while still picking up writes from
      // another app window after a short bound.
      staleTime: 10_000,
      retry: false,
    },
  });
}
