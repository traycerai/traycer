import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostControllerStatus,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

function hostControllerStatusQueryOptions(management: IHostManagement | null) {
  return queryOptions<HostControllerStatus>({
    queryKey:
      management !== null
        ? runnerQueryKeys.hostControllerStatus(management)
        : ["runner.host.controllerStatus", "disabled"],
    queryFn: () => {
      if (management === null) {
        throw new Error("Host management unavailable on this runner host");
      }
      return management.getHostControllerStatus();
    },
    enabled: management !== null,
    // Entirely event-sourced (pushed by `HostControllerStatusListener`) once
    // primed - never polling-appropriate, matching the pattern the old
    // `hostOperationStatus` query established.
    staleTime: Infinity,
  });
}

/**
 * Reads the canonical two-lane `HostControllerStatus` (Host Update Layer
 * Redesign Tech Plan). Primed once via `getHostControllerStatus()` on
 * mount; live updates arrive via `HostControllerStatusListener` pushing
 * into the same query key. Shared by the host gate, update banner, and
 * Settings → Host so every surface renders the identical projection.
 */
export function useRunnerHostControllerStatusQuery(): UseQueryResult<HostControllerStatus> {
  const runnerHost = useRunnerHost();
  return useQuery(hostControllerStatusQueryOptions(runnerHost.hostManagement));
}
