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
   *  - `"fresh-read"`: a read that provably BEGAN at this mount, on its own
   *    cache entry. For a reader that describes a state transition which
   *    HAPPENED JUST NOW - the failed-attempt panel
   *    (`LocalBootstrapAttempts`) mounts on the failure, but the disclosure
   *    beside it read this same query while the start was still healthy, and
   *    a snapshot from 20 seconds ago is "fresh" by the 30-second rule while
   *    describing the attempt BEFORE the one that just failed - or none. Only
   *    `convergeReady`'s SUCCESS invalidates this key, so nothing else would
   *    refresh it in time.
   */
  readonly onMount: "when-stale" | "fresh-read";
}

/**
 * The per-mount discriminator behind `"fresh-read"`, and why it is a counter.
 *
 * This started as `refetchOnMount: "always"`, which is NOT the same promise. A
 * mount-triggered fetch carries no `cancelRefetch`, so query-core's
 * `Query.fetch` hands back the retryer promise of a request that is ALREADY
 * RUNNING instead of starting one (`fetchStatus !== "idle"` → `return
 * this.#retryer.promise`). The disclosure polls this key every 1.5s while
 * `Show details` is open, so at the instant an install fails there is
 * routinely one in flight - taken BEFORE the terminal marker was written. It
 * resolves after the mount, so `isFetchedAfterMount` and `isSuccess` both pass
 * on pre-failure data and the panel draws "Host never reported a terminal
 * status" over a crash that reported one. Fetched-after-mount is not
 * read-after-mount, and no `refetchOnMount` value spells the difference.
 *
 * A key nothing else has used cannot be deduplicated onto: there is no entry
 * and no retryer, so the fetch is genuinely this mount's. It stays a prefix
 * EXTENSION of the shared key, so the recovery mutations' partial-match
 * `invalidateQueries` still reaches it.
 *
 * A counter rather than `useId`, which is derived from tree position and so
 * repeats across an unmount/remount at the same position - handing the second
 * mount the first one's still-running request, which is the bug again. The
 * cost is one small cache entry per settled failure the user looks at, dropped
 * at the default `gcTime`.
 */
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
  // Allocated for every caller and read by one. It has to come from a
  // mount-scoped `useState` initializer to be stable across this mount's
  // renders, and a hook cannot be taken conditionally - so `when-stale`
  // callers burn an integer and ignore it.
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

/**
 * A private entry keeps the failure panel's read out of everyone else's
 * dedup - it should not also keep the answer to itself.
 *
 * The disclosure beside that panel is CLOSED at the moment of a failure, so it
 * is not polling, and its shared entry still holds the snapshot it took while
 * the start was healthy. Opening `Show details` does not refresh it either:
 * `shouldFetchOptionally` gates on `query !== prevQuery || prevOptions.enabled
 * === false`, and a disclosure merely toggling its own `pollIntervalMs`
 * satisfies neither - so the interval it just armed is the first thing that
 * refetches, up to 1.5s later. Until then the user reads a bootstrap.log tail
 * from before the crash, beside a panel describing the crash.
 *
 * So the fresh read is published to the shared entry: it is a newer sample of
 * the same file, and the canonical key is where every other reader looks.
 *
 * Written unconditionally rather than behind a "only if newer" timestamp
 * guard. Such a guard reads as prudent and is in fact unreachable: this effect
 * re-runs only when THIS reader's own data changes, which happens only when
 * this reader refetches - and that sample is always the newest one it has. A
 * later poll by the disclosure cannot provoke a re-run, so there is nothing to
 * roll back. (`dataUpdatedAt` would not even discriminate: `setQueryData` and
 * a resolving read routinely stamp the same millisecond.)
 */
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
