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
}

function traycerHostStatusQueryOptions(
  traycerCli: ITraycerCli | null,
  pollIntervalMs: number | null,
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
  });
}

/**
 * Reads `traycer host status` through the runner-host CLI bridge. Host-
 * independent: works whether the host is up, starting, or wedged.
 * Consumers:
 *   - `LocalHostLoading` - polls while the gate is in `loading` / `slow`
 *     so the live bootstrap.log tail and recent markers stay fresh.
 *   - `LocalHostUnavailable` (failure card) - single read; the renderer
 *     stops driving updates while the user reads the diagnostics.
 *
 * Disabled on shells without a CLI (mobile, web) - `traycerCli === null`.
 */
export function useRunnerTraycerHostStatusQuery(
  opts: UseRunnerTraycerHostStatusQueryOptions,
): UseQueryResult<TraycerHostStatusSnapshot> {
  const runnerHost = useRunnerHost();
  return useQuery(
    traycerHostStatusQueryOptions(runnerHost.traycerCli, opts.pollIntervalMs),
  );
}
