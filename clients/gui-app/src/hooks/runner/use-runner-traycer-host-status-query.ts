import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerHostStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

export interface UseRunnerTraycerHostStatusQueryOptions {
  /**
   * Refetch interval in ms while the query is mounted. `null` disables
   * polling (default - used by the failure card so it doesn't keep
   * re-fetching while the user reads it). The loading screen passes a
   * short interval so the bootstrap.log tail stays fresh while the
   * host is starting up.
   */
  readonly pollIntervalMs: number | null;
  /**
   * What a MOUNT does with a snapshot already in the cache.
   *
   *  - `"when-stale"`: the ordinary rule - reuse it while it is within
   *    `staleTime`, refetch otherwise. For a reader that shows the LIVE tail
   *    (`BootstrapLogDisclosure`), whose poll refreshes it anyway.
   *  - `"always"`: refetch on mount regardless, and let the caller gate on
   *    `isFetchedAfterMount` so it never presents the cached one. For a
   *    reader that describes a state transition that HAPPENED JUST NOW -
   *    the failed-attempt panel (`LocalBootstrapAttempts`) mounts on the
   *    failure, but the disclosure beside it read this same query while the
   *    start was still healthy, and a snapshot from 20 seconds ago is
   *    "fresh" by the 30-second rule while describing the attempt BEFORE
   *    the one that just failed - or none. Only `convergeReady`'s SUCCESS
   *    invalidates this key, so nothing else would refresh it in time.
   */
  readonly onMount: "when-stale" | "always";
}

function traycerHostStatusQueryOptions(
  traycerCli: ITraycerCli | null,
  pollIntervalMs: number | null,
  onMount: "when-stale" | "always",
) {
  return queryOptions<TraycerHostStatusSnapshot>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerHostStatus(traycerCli)
        : ["runner.traycer.hostStatus", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.hostStatus();
    },
    enabled: traycerCli !== null,
    // Bootstrap state changes only on host (re)spawn or as bootstrap.log
    // gets new lines. With pollIntervalMs set, refetchInterval drives
    // freshness. Without it, callers get the cached value until next
    // explicit invalidate.
    staleTime: pollIntervalMs !== null ? 0 : 30_000,
    refetchInterval: pollIntervalMs ?? false,
    refetchOnMount: onMount === "always" ? "always" : true,
  });
}

/**
 * Reads `traycer host status` through the runner-host CLI bridge. Host-
 * independent: works whether the host is up, starting, or wedged.
 * Consumers:
 *   - `BootstrapLogDisclosure` (every boot card's `Show details`) - polls only
 *     while the disclosure is open, so the live bootstrap.log tail stays
 *     fresh while a user watches.
 *   - `LocalBootstrapAttempts` (the narrator's settled arm and the gate's
 *     `provisioning-error` card) - a single FRESH read on mount, then no
 *     polling: the renderer stops driving updates while the user reads the
 *     diagnostics. See `onMount`.
 *
 * Disabled on shells without a CLI (mobile, web) - `traycerCli === null`.
 */
export function useRunnerTraycerHostStatusQuery(
  opts: UseRunnerTraycerHostStatusQueryOptions,
): UseQueryResult<TraycerHostStatusSnapshot> {
  const runnerHost = useRunnerHost();
  return useQuery(
    traycerHostStatusQueryOptions(
      runnerHost.traycerCli,
      opts.pollIntervalMs,
      opts.onMount,
    ),
  );
}
