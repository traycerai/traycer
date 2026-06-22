import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerDetectedShell,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function traycerShellListQueryOptions(traycerCli: ITraycerCli | null) {
  return queryOptions<readonly TraycerDetectedShell[]>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerShellList(traycerCli)
        : ["runner.traycer.shellList", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.shellListDetected();
    },
    enabled: traycerCli !== null,
    // Installed shells change rarely; cache for the session. The combobox
    // always accepts a typed custom path, so a stale or empty list is benign.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Lists shells detected on this machine (`traycer config shell list`) to
 * populate the Settings → Shell quick-picks. Disabled when
 * `traycerCli === null` (mobile/web hosts).
 */
export function useRunnerTraycerShellListQuery(): UseQueryResult<
  readonly TraycerDetectedShell[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(traycerShellListQueryOptions(runnerHost.traycerCli));
}
