import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { countTaskWorktrees } from "@/components/epics/sweep-host-model";

/**
 * How long a host's count is served from cache before the popover asks again.
 *
 * The same window the agent hover already uses for this very RPC
 * (`use-worktree-owner-metadata-query.ts`), reused rather than minted: a
 * popover re-opened within it shows the cached answer, and only PICKING the
 * host forces a fresh read - the dialog's own forced census. Note host-query
 * `staleTime` only de-duplicates within one `HostRuntime` session; a runtime
 * start invalidates the whole `["host"]` scope, which is fine here.
 */
const SWEEP_HOST_COUNT_STALE_MS = 60_000;

/**
 * The number of worktrees one host holds for the selected Task(s), for a row
 * in the Sweep host popover - or `null` when it is not known.
 *
 * ON DEMAND, never proactive: the query is enabled only while the caller says
 * so (the popover is open and the row is dialable), and it reads the host's
 * TTL-cached base walk (`forceRefresh: false`, no activity probes), which is
 * the cheapest question a host can be asked about its worktrees. `null` is
 * the answer for loading, failed and unreachable alike; the row renders no
 * number for any of them, so it can never claim a zero it has not proven.
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
