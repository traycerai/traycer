import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostLifecycleView,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import {
  runnerHostQueryScopeId,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The lifecycle view's cache key for one runner-host instance. Exported so the
 * set mutation writes the answer it received into the SAME entry the card
 * reads, rather than rebuilding the key and drifting from it.
 */
export function hostLifecycleViewQueryKey(runnerHost: IRunnerHost | null) {
  return runnerHost === null || runnerHost.hostLifecycle === null
    ? runnerQueryKeys.hostLifecycleViewUnavailable()
    : runnerQueryKeys.hostLifecycleView(runnerHostQueryScopeId(runnerHost));
}

export function hostLifecycleViewQueryOptions(runnerHost: IRunnerHost | null) {
  return queryOptions<HostLifecycleView>({
    queryKey: hostLifecycleViewQueryKey(runnerHost),
    queryFn: () => {
      const hostLifecycle =
        runnerHost === null ? null : runnerHost.hostLifecycle;
      if (hostLifecycle === null) {
        throw new Error("The host lifecycle is only set in the desktop app.");
      }
      return hostLifecycle.get();
    },
    enabled: runnerHost !== null && runnerHost.hostLifecycle !== null,
    // Always re-read on mount. `onChange` below keeps a MOUNTED reader current
    // (including a CLI `traycer host lifecycle set`), but it is disposed with
    // the reader, so a change made while nothing was mounted is only caught by
    // asking again. `get()` is one IPC read of two small files.
    staleTime: 0,
  });
}

/**
 * This machine's host lifecycle mode as desktop main reads it: desired (the
 * policy file) and applied (what this launch runs under). Disabled on shells
 * with no lifecycle to set (mobile, web, tests).
 *
 * The change subscription is the sanctioned external-sync effect: main pushes
 * a fresh view for every change it observes, and the push IS the new state,
 * so it is written straight into the cache - never replayed as a `set`.
 */
export function useRunnerHostLifecycleQuery(): UseQueryResult<HostLifecycleView> {
  const runnerHost = useRunnerHostOrNull();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (runnerHost === null) return;
    const hostLifecycle = runnerHost.hostLifecycle;
    if (hostLifecycle === null) return;
    const subscription = hostLifecycle.onChange((view) => {
      queryClient.setQueryData(hostLifecycleViewQueryKey(runnerHost), view);
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, queryClient]);

  return useQuery(hostLifecycleViewQueryOptions(runnerHost));
}
