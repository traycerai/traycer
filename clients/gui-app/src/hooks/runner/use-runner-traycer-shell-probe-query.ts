import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerShellProbeResult,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

export function traycerShellProbeQueryOptions(
  traycerCli: ITraycerCli | null,
  path: string,
  enabled: boolean,
) {
  return queryOptions<TraycerShellProbeResult>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerShellProbe(traycerCli, path)
        : ["runner.traycer.shellProbe", "disabled", path],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.shellProbe({ path });
    },
    enabled: enabled && traycerCli !== null,
    // A given path's existence/executability doesn't change under the user's
    // feet mid-session, so cache the answer and never refetch on focus.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Probes whether `path` exists and is executable, backing the picker's live
 * "Add a shell" validation. The caller passes the already-debounced path and an
 * `enabled` gate (only absolute, non-empty paths are worth probing). Disabled
 * when `traycerCli === null` (mobile/web hosts).
 */
export function useRunnerTraycerShellProbeQuery(input: {
  readonly path: string;
  readonly enabled: boolean;
}): UseQueryResult<TraycerShellProbeResult> {
  const runnerHost = useRunnerHost();
  return useQuery(
    traycerShellProbeQueryOptions(
      runnerHost.traycerCli,
      input.path,
      input.enabled,
    ),
  );
}
