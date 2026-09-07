import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useActiveUpdatePollAccelerator } from "@/hooks/host/use-active-update-poll-accelerator";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { observationFromCanonicalRead } from "@/lib/host/fleet-update/canonical-status-observation";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";
import {
  preferLiveOverRecord,
  projectFleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostRpcRegistry } from "@/lib/host";

const EMPTY_PARAMS = {} as const;

export interface LocalHostUpdateOperation {
  /** `null` before this client knows which host is local. */
  readonly hostId: string | null;
  readonly view: FleetUpdateView;
}

/**
 * Unbound runtime: `unknown`/`qualified`, never `idle`. "We did not look" must not render as "there is no update".
 */
export const UNBOUND_LOCAL_UPDATE_OPERATION: LocalHostUpdateOperation = {
  hostId: null,
  // The shared constant, not a hand-written copy of it.
  view: UNKNOWN_FLEET_UPDATE_VIEW,
};

/** Requires HostRuntimeProvider (useHostClient throws without it). Share the host.status query key; do not open a private one. */
export function useLocalHostUpdateOperation(): LocalHostUpdateOperation {
  const hostId = useReactiveLocalHostId();
  const client = useHostClientForHostId(hostId);
  const readiness = useReactiveHostReadiness(client);
  // The durable-record leg's source. Event-sourced and already shared by the
  // host gate, update banner and Settings, so this adds no poll.
  const controllerStatusQuery = useRunnerHostControllerStatusQuery();
  const statusQuery = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: EMPTY_PARAMS,
    // The table owns the baseline cadence (fixed 10s). `staleTime` exceeds it
    // for the same reason the Overview's does: a healthy poll keeps the data
    // fresh, and ageing past the window is what demotes an unhealthy read.
    options: { enabled: hostId !== null, staleTime: 30_000, poll: true },
  });

  // Stamp from `dataUpdatedAt` and demote by the query's own read health. An in-flight fetch is live only inside that health rule; `fetchStatus === "fetching"` must not pin `nowMs` forever.
  const observation =
    statusQuery.data === undefined || hostId === null
      ? null
      : observationFromCanonicalRead({
          hostId,
          status: statusQuery.data,
          dataUpdatedAt: statusQuery.dataUpdatedAt,
          health: {
            isError: statusQuery.isError,
            fetchStatus: statusQuery.fetchStatus,
            isStale: statusQuery.isStale,
            hasLiveSource: readiness.isReady,
          },
          source: "local",
        });

  // Canonical leg: dataUpdatedAt, not a clock. Record observedAtMs must come from the controller query, never live host.status (0 while the host is down).
  const recordObservation =
    hostId === null
      ? null
      : recordObservationFromLocalAttempt({
          hostId,
          localAttempt: controllerStatusQuery.data?.localAttempt ?? null,
          observedAtMs: controllerStatusQuery.dataUpdatedAt,
        });
  const view = projectFleetUpdateView({
    observation: preferLiveOverRecord(
      observation,
      recordObservation,
      statusQuery.dataUpdatedAt,
    ),
    nowMs: statusQuery.dataUpdatedAt,
    connected: readiness.isReady,
  });

  useActiveUpdatePollAccelerator({ hostId, view });

  return { hostId, view };
}
