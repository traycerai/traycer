import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostRemovalState,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

export interface UseRunnerHostRemovalStateQueryOptions {
  readonly enabled: boolean;
}

function hostRemovalStateQueryOptions(
  management: IHostManagement | null,
  enabled: boolean,
) {
  return queryOptions<HostRemovalState>({
    queryKey:
      management !== null
        ? runnerQueryKeys.hostRemovalState(management)
        : ["runner.host.removalState", "disabled"],
    queryFn: () => {
      if (management === null) {
        throw new Error("Host management unavailable on this runner host");
      }
      return management.getRemovalState();
    },
    enabled: enabled && management !== null,
    // Always re-check on activation rather than serve a cached "not removed"
    // answer - this query exists specifically to notice a removal that
    // happened while it was disabled (see the host gate's usage).
    staleTime: 0,
  });
}

/**
 * Reads the persisted "removed by user" sentinel directly via
 * `IHostManagement.getRemovalState()`, independent of `ensureHost`'s one-shot
 * auto-provision. Consumed by `useHostProvisioning` in `local-host-gate.tsx`
 * so a removal that happens after the initial connect (Settings -> Danger
 * Zone -> Remove Traycer) is picked up without requiring a reload.
 */
export function useRunnerHostRemovalStateQuery(
  opts: UseRunnerHostRemovalStateQueryOptions,
): UseQueryResult<HostRemovalState> {
  const runnerHost = useRunnerHost();
  return useQuery(
    hostRemovalStateQueryOptions(runnerHost.hostManagement, opts.enabled),
  );
}
