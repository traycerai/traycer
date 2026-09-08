import { useQuery } from "@tanstack/react-query";
import { hostControllerStatusQueryOptions } from "@/hooks/runner/use-runner-host-controller-status-query";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";
import type { FleetUpdateRecordObservation } from "@/lib/host/fleet-update/fleet-update-view";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The durable attempt record on THIS machine, as an observation — the single
 * production reader of `HostControllerStatus.localAttempt`.
 *
 * Both surfaces that show this machine's host during the host-down window read
 * it here: the landing banner's hook and the selected-host Overview. One reader
 * rather than two matters for a reason beyond tidiness — `observedAtMs` has to
 * be stamped by the query that actually performed the read, and the two
 * surfaces have different other queries lying around to borrow a timestamp
 * from. The Overview's `host.status` leg, in particular, has NEVER succeeded in
 * the window this arm exists for, so its `dataUpdatedAt` is `0` and a record
 * freshly read from local disk would be reported as observed at the Unix epoch.
 *
 * `hostId` is the host this observation would be ABOUT, and `null` withdraws
 * the leg entirely — including the READ. Passing it is how the Overview stays
 * correct for a REMOTE scoped host: the record on this machine's disk describes
 * this machine's host and nothing else, so attributing it to a remote host
 * would put one machine's update on another machine's page. Disabling rather
 * than merely discarding matters because the query is a bridge round trip on
 * first prime; a surface with nothing to do with it must not be what causes
 * one. The entry is shared, so a consumer that IS enabled keeps it live for
 * everyone and this observer simply reads along.
 *
 * Rendering outside a `<RunnerHostProvider>` yields `null` rather than
 * throwing: the Overview is reachable in shells with no runner host, and a
 * missing bridge is "we cannot say", exactly as an unreadable record is.
 */
export function useLocalAttemptRecordObservation(
  hostId: string | null,
): FleetUpdateRecordObservation | null {
  const management = useRunnerHostOrNull()?.hostManagement ?? null;
  const options = hostControllerStatusQueryOptions(management);
  const query = useQuery({
    ...options,
    enabled: options.enabled && hostId !== null,
  });
  if (hostId === null) return null;
  return recordObservationFromLocalAttempt({
    hostId,
    localAttempt: query.data?.localAttempt ?? null,
    observedAtMs: query.dataUpdatedAt,
  });
}
