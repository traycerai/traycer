import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerShellConfig,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function traycerShellConfigQueryOptions(traycerCli: ITraycerCli | null) {
  return queryOptions<TraycerShellConfig>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerShellConfig(traycerCli)
        : ["runner.traycer.shellConfig", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.shellConfigGet();
    },
    enabled: traycerCli !== null,
  });
}

/**
 * Reads the effective shell config (path + args + synthesised flag) through
 * `traycer config shell get`. Drives the Settings → Shell & environment form
 * and the bootstrap-failure card's "shell that was attempted" line.
 *
 * Disabled when `traycerCli === null`.
 */
export function useRunnerTraycerShellConfigQuery(): UseQueryResult<TraycerShellConfig> {
  const runnerHost = useRunnerHost();
  return useQuery(traycerShellConfigQueryOptions(runnerHost.traycerCli));
}
