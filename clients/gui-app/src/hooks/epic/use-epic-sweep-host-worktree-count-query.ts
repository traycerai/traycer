import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { countTaskWorktrees } from "@/components/epics/sweep-host-model";

/**
 * Same stale window as `use-worktree-owner-metadata-query`. Only picking the host forces a fresh census.
 */
const SWEEP_HOST_COUNT_STALE_MS = 60_000;

/**
 * On demand, `forceRefresh: false`. `null` covers loading, failed, and unreachable so the row never claims a zero it has not proven.
 */
export function useEpicSweepHostWorktreeCount(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly enabled: boolean;
}): number | null {
  const query = useHostQuery({
    client: input.client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    },
    cacheKeyIdentity: undefined,
    options: {
      enabled: input.enabled && input.client !== null,
      staleTime: SWEEP_HOST_COUNT_STALE_MS,
      retry: false,
    },
  });
  if (query.data === undefined) return null;
  return countTaskWorktrees(query.data.worktrees, input.selectedEpicIds);
}
