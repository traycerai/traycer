import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostOperationStatus,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

/**
 * Reads the canonical cross-surface host-operation snapshot. The status is
 * event-sourced by HostOperationStatusListener, so every consumer must share
 * this exact key and treat cached data as authoritative between push events.
 */
export function useRunnerHostOperationStatusQuery(
  management: IHostManagement,
): UseQueryResult<HostOperationStatus | null> {
  return useQuery(
    queryOptions<HostOperationStatus | null>({
      queryKey: runnerQueryKeys.hostOperationStatus(management),
      queryFn: () => management.getOperationStatus(),
      staleTime: Infinity,
    }),
  );
}
