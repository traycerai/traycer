import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorkspacePrepareFoldersRequestV12 } from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The host's recently-opened workspaces, for the remote folder picker's
 * shortcut row (`workspace.prepareFolders` v1.1 `listRecentWorkspaces`).
 *
 * Constant params, so the object is hoisted rather than memoized.
 */
const LIST_RECENT_WORKSPACES_PARAMS: WorkspacePrepareFoldersRequestV12 = {
  operation: "listRecentWorkspaces",
  folderPaths: null,
  path: null,
  bumpRecency: null,
};

/**
 * Recents are a CONVENIENCE on top of browsing, never a precondition for it.
 * Against a v1.0 host this operation fails closed with
 * `HostRpcError(code: "DOWNGRADE_UNSUPPORTED")` - the picker simply renders no
 * shortcut row and browsing continues to work, so callers must not surface
 * this error. `retry: false` keeps a host that cannot answer from being asked
 * repeatedly.
 *
 * The client is the REQUESTER's (tab-bound where the pick started), matching
 * `useWorkspaceBrowseFolders` - the recents shown must belong to the same
 * machine the picked path is sent to.
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
      // Re-read on every open: a pick made in a previous open appended to
      // this list, and the picker is short-lived enough that a stale row
      // would be the common case rather than the exception.
      staleTime: 0,
      retry: false,
    },
  });
}
