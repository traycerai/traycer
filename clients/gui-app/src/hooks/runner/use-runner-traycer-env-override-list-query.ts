import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerEnvOverride,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function traycerEnvOverrideListQueryOptions(traycerCli: ITraycerCli | null) {
  return queryOptions<readonly TraycerEnvOverride[]>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerEnvOverrideList(traycerCli)
        : ["runner.traycer.envOverrideList", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.envOverrideList();
    },
    enabled: traycerCli !== null,
  });
}

/**
 * Reads all env overrides through `traycer config env list`. Powers the
 * env table in Settings → Shell & environment.
 */
export function useRunnerTraycerEnvOverrideListQuery(): UseQueryResult<
  readonly TraycerEnvOverride[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(traycerEnvOverrideListQueryOptions(runnerHost.traycerCli));
}
