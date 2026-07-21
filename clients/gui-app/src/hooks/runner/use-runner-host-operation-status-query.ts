import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostOperationStatusEnvelope,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function isHostOperationStatusEnvelope(
  value: unknown,
): value is HostOperationStatusEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "revision" in value &&
    typeof value.revision === "number"
  );
}

export function selectNewestHostOperationStatusEnvelope(
  current: HostOperationStatusEnvelope | undefined,
  incoming: HostOperationStatusEnvelope,
): HostOperationStatusEnvelope {
  return current !== undefined && current.revision > incoming.revision
    ? current
    : incoming;
}

/**
 * Reads the canonical cross-surface host-operation snapshot. The status is
 * event-sourced by HostOperationStatusListener, so every consumer must share
 * this exact key and treat cached data as authoritative between push events.
 * A stale snapshot read must never clobber a newer pushed envelope, so the
 * queryFn result is merged into the cache by revision via `structuralSharing`
 * (the push listener applies the same monotonic rule on its own writes).
 */
export function useRunnerHostOperationStatusQuery(
  management: IHostManagement,
): UseQueryResult<HostOperationStatusEnvelope> {
  const queryKey = runnerQueryKeys.hostOperationStatus(management);
  return useQuery(
    queryOptions<HostOperationStatusEnvelope>({
      queryKey,
      queryFn: () => management.getOperationStatus(),
      structuralSharing: (oldData, newData) => {
        if (!isHostOperationStatusEnvelope(newData)) return newData;
        const previous = isHostOperationStatusEnvelope(oldData)
          ? oldData
          : undefined;
        return selectNewestHostOperationStatusEnvelope(previous, newData);
      },
      staleTime: Infinity,
    }),
  );
}
