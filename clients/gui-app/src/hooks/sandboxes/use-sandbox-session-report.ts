import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostOverviewStatusQuery } from "@/components/settings/panels/host-overview-rpc";
import { liveBusySessionCount } from "@/components/settings/panels/my-hosts-model";
import {
  sandboxSessionKinds,
  type SandboxSessionReport,
} from "@/lib/sandboxes/sandbox-row-lines";

/**
 * What a sandbox host last reported about its running sessions, for the
 * Sandboxes row and the confirmations. Settings is not in a task, so the
 * task-scoped agent and terminal lists do not answer it: the host-wide fact
 * is `host.status`'s `sessions`, every running agent and open terminal (idle
 * ones included, which `busySessionCount` leaves out: that count is what an
 * update drain waits for), read as the Overview reads it. A live read is the
 * list; an answer that is no longer live is its count `as of` its age; no
 * list at all, from a host below @1.9, is unknown, never a zero.
 *
 * `enabled` is false on a resting row: a read never wakes a sandbox, and a
 * resting one has no sessions to report.
 */
export function useSandboxSessionReport(
  hostId: string,
  enabled: boolean,
): {
  readonly report: SandboxSessionReport;
  /** The status read failed while the control plane says awake. */
  readonly failed: boolean;
} {
  const client = useHostClientForHostId(hostId);
  const status = useHostOverviewStatusQuery({
    client,
    enabled: enabled && client !== null,
    hostId,
  });
  const data = status.data ?? null;
  const sessions = data?.sessions ?? null;
  const kinds = sandboxSessionKinds(sessions);
  const count = kinds === null ? null : kinds.agents + kinds.terminals;
  const live = liveBusySessionCount({
    reportedCount: count,
    isError: status.isError,
    fetchStatus: status.fetchStatus,
    isStale: status.isStale,
    hasLiveSource: enabled && client !== null,
  });
  if (data !== null && sessions !== null && kinds !== null && live !== null) {
    return {
      report: { kind: "live", count: live, busy: data.busy, kinds, sessions },
      failed: false,
    };
  }
  // A read that never answered has no time; its count is not "as of" one.
  if (count !== null && status.dataUpdatedAt > 0) {
    return {
      report: { kind: "stale", count, at: status.dataUpdatedAt },
      failed: status.isError,
    };
  }
  return { report: { kind: "unknown" }, failed: status.isError };
}
