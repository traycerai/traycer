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
 * The host's home directory (`workspace.prepareFolders` v1.1 `getHomeDir`),
 * used by the remote folder picker to anchor `~`.
 *
 * The picker also learns home from its root (null-path) browse response, and
 * prefers that. This query is what makes `~` work when that browse never
 * SUCCEEDS: a home directory the host cannot list (consent-gated, denied)
 * still expands, and Add needs no listing - so the user can still type
 * `~/projects/api` and pick it out of an unlistable home.
 *
 * Fails closed with `DOWNGRADE_UNSUPPORTED` against a v1.0 host; the picker
 * falls back to the browse-derived home and shows nothing about it.
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
      retry: false,
    },
  });
}
