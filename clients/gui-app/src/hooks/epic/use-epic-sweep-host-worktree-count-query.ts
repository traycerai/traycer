import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useWorktreeHostListingForClient } from "@/hooks/worktree/use-worktree-host-listing";
import { countTaskWorktrees } from "@/components/epics/sweep-host-model";

/**
 * The number of worktrees one host holds for the selected Task(s), for a row
 * in the Sweep host popover - or `null` when it is not known.
 *
 * ON DEMAND, never proactive: the query is enabled only while the caller says
 * so (the popover is open and the row is dialable), and it reads the shared
 * host listing (`useWorktreeHostListingForClient`), a non-spawning cached
 * walk. `null` is
 * the answer for loading, failed and unreachable alike; the row renders no
 * number for any of them, so it can never claim a zero it has not proven.
 */
export function useEpicSweepHostWorktreeCount(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly enabled: boolean;
}): number | null {
  // The shared host listing: warm whenever any other worktree surface has read
  // this host, and refreshed by the host's `worktree.changed` frames.
  const listing = useWorktreeHostListingForClient(
    input.client,
    input.enabled && input.client !== null,
  );
  if (!listing.isSuccess) return null;
  return countTaskWorktrees(listing.worktrees, input.selectedEpicIds);
}
