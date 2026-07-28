/**
 * Query key builders for workspace host data that is fed by a stream rather
 * than fetched. Prefixed with `hostQueryKeys.scope(hostId)` so a host scope
 * invalidation drops them with everything else on that host (ADR-0006).
 */

import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

export const workspaceQueryKeys = {
  /**
   * Live single-level directory listings for one workspace, fed by the
   * `workspace.subscribeFileList` stream. One slot per (host, workspace); the
   * cached value carries one entry per covered directory, each replaced
   * wholesale by that directory's latest `listing` frame.
   */
  fileList: (hostId: string | null, workspacePath: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      "workspace",
      "fileList",
      workspacePath,
    ] as const,
};
