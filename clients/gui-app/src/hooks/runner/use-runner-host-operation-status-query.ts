import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostOperationStatusEnvelope,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { resolveDesktopHostOperationStatusBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
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
  management: IHostManagement | null,
): UseQueryResult<HostOperationStatusEnvelope> {
  const runnerHost = useRunnerHost();
  const hasDesktopStatusBridge =
    resolveDesktopHostOperationStatusBridge(runnerHost) !== null;
  const queryKey =
    management !== null
      ? runnerQueryKeys.hostOperationStatus(management)
      : ["runner.host.operationStatus", "disabled"];
  return useQuery(
    queryOptions<HostOperationStatusEnvelope>({
      queryKey,
      queryFn: () => {
        if (management === null) {
          throw new Error("Host management unavailable on this runner host");
        }
        return management.getOperationStatus();
      },
      structuralSharing: (oldData, newData) => {
        if (!isHostOperationStatusEnvelope(newData)) return newData;
        const previous = isHostOperationStatusEnvelope(oldData)
          ? oldData
          : undefined;
        return selectNewestHostOperationStatusEnvelope(previous, newData);
      },
      // Desktop renderers subscribe before their initial snapshot through
      // HostOperationStatusListener. Non-desktop/test runners have no push
      // bridge, so this query owns a bounded-backoff snapshot retry instead.
      // Either path stays unknown until an envelope arrives; a cache entry is
      // never used as an eternal substitute for main's revisioned source.
      enabled: management !== null && !hasDesktopStatusBridge,
      retry: true,
      retryDelay: (attemptIndex) =>
        Math.min(30_000, 1_000 * 2 ** Math.min(attemptIndex, 5)),
      staleTime: 0,
    }),
  );
}
