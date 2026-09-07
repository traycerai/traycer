import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { FLEET_ACTIVE_POLL_MS } from "@/lib/host/fleet-update/fleet-poll-policy";
import {
  warrantsFastPoll,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

/** Not a condition policy: that would drop the 10s baseline for other consumers. Invalidate the shared key so every surface reading that host accelerates together. */
interface AcceleratorEntry {
  count: number;
  readonly timer: ReturnType<typeof setInterval>;
}

/** One refcounted timer per (query client, host), not per mounted consumer. */
const acceleratorsByClient = new WeakMap<
  QueryClient,
  Map<string, AcceleratorEntry>
>();

function acquireAccelerator(
  queryClient: QueryClient,
  hostId: string,
): () => void {
  let byHost = acceleratorsByClient.get(queryClient);
  if (byHost === undefined) {
    byHost = new Map<string, AcceleratorEntry>();
    acceleratorsByClient.set(queryClient, byHost);
  }
  const hosts = byHost;
  const existing = hosts.get(hostId);
  if (existing !== undefined) {
    existing.count += 1;
  } else {
    hosts.set(hostId, {
      count: 1,
      timer: setInterval(() => {
        // On a link whose `host.status` RTT exceeds this cadence that is not "slightly stale" - it is a poll that NEVER completes, every request dying at the next tick while the wire churns.
        void queryClient.invalidateQueries(
          { queryKey: hostQueryKeys.methodScope(hostId, "host.status") },
          { cancelRefetch: false },
        );
      }, FLEET_ACTIVE_POLL_MS),
    });
  }
  let released = false;
  return () => {
    // Idempotent: React can invoke a cleanup more than once (StrictMode's
    // mount/unmount/remount), and a second decrement would retire a timer other
    // consumers are still relying on.
    if (released) return;
    released = true;
    const entry = hosts.get(hostId);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    clearInterval(entry.timer);
    hosts.delete(hostId);
  };
}

export function useActiveUpdatePollAccelerator(input: {
  readonly hostId: string | null;
  readonly view: FleetUpdateView;
}): void {
  const queryClient = useQueryClient();
  const { hostId } = input;
  const fast = warrantsFastPoll(input.view);
  useEffect(() => {
    if (hostId === null || !fast) return;
    return acquireAccelerator(queryClient, hostId);
  }, [hostId, fast, queryClient]);
}

/** Test-only: how many consumers currently hold this host's accelerator. */
export function activeUpdateAcceleratorCountForTest(
  queryClient: QueryClient,
  hostId: string,
): number {
  return acceleratorsByClient.get(queryClient)?.get(hostId)?.count ?? 0;
}
