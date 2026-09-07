import { useEffect, useState } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerHostStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

export interface UseRunnerTraycerHostStatusQueryOptions {
  /** Refetch interval in ms while the query is mounted. */
  readonly pollIntervalMs: number | null;
  /**
   * `when-stale` reuses the cache within `staleTime`. `fresh-read` starts its own cache entry at this mount so a just-failed attempt is not described by a still-fresh older snapshot.
   */
  readonly onMount: "when-stale" | "fresh-read";
}

/** Per-mount key prefix so this fetch cannot join an in-flight poll. Counter, not useId: tree position repeats across remount. */
let freshReadSequence = 0;

function nextFreshReadId(): number {
  freshReadSequence += 1;
  return freshReadSequence;
}

function traycerHostStatusQueryKey(
  traycerCli: ITraycerCli | null,
  onMount: "when-stale" | "fresh-read",
  freshReadId: number,
): readonly unknown[] {
  if (traycerCli === null) return runnerQueryKeys.traycerHostStatusDisabled();
  if (onMount === "when-stale") {
    return runnerQueryKeys.traycerHostStatus(traycerCli);
  }
  return runnerQueryKeys.traycerHostStatusFreshRead(traycerCli, freshReadId);
}

function traycerHostStatusQueryOptions(
  traycerCli: ITraycerCli | null,
  pollIntervalMs: number | null,
  onMount: "when-stale" | "fresh-read",
  freshReadId: number,
) {
  return queryOptions<TraycerHostStatusSnapshot>({
    // `traycerCli` is passed rather than closed over so
    // `@tanstack/query/exhaustive-deps` can see it in the key expression -
    // the rule reads this property, not what a local was built from.
    queryKey: traycerHostStatusQueryKey(traycerCli, onMount, freshReadId),
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.hostStatus();
    },
    enabled: traycerCli !== null,
    // Without it, callers get the cached value until next explicit invalidate.
    staleTime: pollIntervalMs !== null ? 0 : 30_000,
    refetchInterval: pollIntervalMs ?? false,
  });
}

/**
 * `traycer host status` via the CLI bridge, independent of host liveness. Disabled when `traycerCli === null`.
 */
export function useRunnerTraycerHostStatusQuery(
  opts: UseRunnerTraycerHostStatusQueryOptions,
): UseQueryResult<TraycerHostStatusSnapshot> {
  const runnerHost = useRunnerHost();
  // It has to come from a mount-scoped `useState` initializer to be stable across this mount's renders, and a hook cannot be taken conditionally - so `when-stale` callers burn an integer and ignore it.
  const [freshReadId] = useState(nextFreshReadId);
  const query = useQuery(
    traycerHostStatusQueryOptions(
      runnerHost.traycerCli,
      opts.pollIntervalMs,
      opts.onMount,
      freshReadId,
    ),
  );
  usePublishFreshReadToSharedEntry({
    enabled: opts.onMount === "fresh-read",
    traycerCli: runnerHost.traycerCli,
    data: query.data,
  });
  return query;
}

/** Publish this mount's fresh read onto the shared key so Show details does not keep the pre-crash snapshot. */
function usePublishFreshReadToSharedEntry(args: {
  readonly enabled: boolean;
  readonly traycerCli: ITraycerCli | null;
  readonly data: TraycerHostStatusSnapshot | undefined;
}): void {
  const queryClient = useQueryClient();
  const { enabled, traycerCli, data } = args;
  useEffect(() => {
    if (!enabled || traycerCli === null || data === undefined) return;
    queryClient.setQueryData(
      runnerQueryKeys.traycerHostStatus(traycerCli),
      data,
    );
  }, [enabled, traycerCli, data, queryClient]);
}
