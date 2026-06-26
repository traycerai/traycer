import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerDiagnosticsConfigSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { useOptionalRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";
import { isHostDiagnosticsApplied } from "@/lib/diagnostics-applied";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";

// Floor for the expiry-triggered refetch. The snapshot's expiry is evaluated
// against the host/CLI clock, so a renderer clock that leads the host would
// otherwise compute a non-positive delay and reschedule immediately, busy-
// looping CLI/host round-trips until the host clock catches up. A 1s floor
// turns that into a slow poll bounded by the skew.
const MIN_EXPIRY_REFRESH_MS = 1_000;

function traycerDiagnosticsConfigQueryOptions(
  traycerCli: ITraycerCli | null,
  hostId: string | null,
) {
  return queryOptions<TraycerDiagnosticsConfigSnapshot>({
    queryKey: runnerQueryKeys.traycerDiagnosticsConfig(hostId, traycerCli),
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.diagnosticsConfigGet();
    },
    enabled: traycerCli !== null,
    refetchInterval: (query) => {
      const snapshot = query.state.data;
      if (snapshot === undefined) return false;
      return diagnosticsRefreshIntervalMs(snapshot);
    },
  });
}

export function useRunnerTraycerDiagnosticsConfigQuery(): UseQueryResult<TraycerDiagnosticsConfigSnapshot> {
  const runnerHost = useOptionalRunnerHost();
  const traycerCli = runnerHost?.traycerCli ?? null;
  const activeHostId = useReactiveActiveHostId();
  return useQuery(
    traycerDiagnosticsConfigQueryOptions(traycerCli, activeHostId),
  );
}

function diagnosticsRefreshIntervalMs(
  snapshot: TraycerDiagnosticsConfigSnapshot,
): number | false {
  const pollMs = diagnosticsStatusPollMs(snapshot);
  const expiryMs = diagnosticsExpiryRefreshMs(snapshot);
  return earliestDelayMs(pollMs, expiryMs) ?? false;
}

function diagnosticsStatusPollMs(
  snapshot: TraycerDiagnosticsConfigSnapshot,
): number | null {
  const status = snapshot.hostStatus;
  if (!status.supported || status.restartRequired) return null;
  // Poll while the running host has not yet confirmed the configured level -
  // including the configMtimeMs === null case, where the old guard returned
  // null and left the UI stuck on "waiting" with no refetch.
  if (isHostDiagnosticsApplied(snapshot)) return null;
  return 1_000;
}

function diagnosticsExpiryRefreshMs(
  snapshot: TraycerDiagnosticsConfigSnapshot,
): number | null {
  const expiries = [
    snapshot.effective.general.expiresAt,
    snapshot.effective.host.expiresAt,
  ].flatMap((expiresAt) => {
    if (expiresAt === null) return [];
    const timestamp = Date.parse(expiresAt);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  if (expiries.length === 0) return null;
  return Math.max(
    Math.min(...expiries) - Date.now() + 250,
    MIN_EXPIRY_REFRESH_MS,
  );
}

function earliestDelayMs(
  first: number | null,
  second: number | null,
): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}
