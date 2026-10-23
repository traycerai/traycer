import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostOverviewStatusQuery } from "@/components/settings/panels/host-overview-rpc";
import { liveBusySessionCount } from "@/components/settings/panels/my-hosts-model";
import type { SandboxSessionReport } from "@/lib/sandboxes/sandbox-row-lines";

/**
 * What a sandbox host last reported about its running sessions, for the
 * Sandboxes row and the confirmations. Settings is not in a task, so the
 * task-scoped agent and terminal lists do not answer it: the host-wide fact
 * is `host.status`'s `busySessionCount` (with `busy`), read as the Overview
 * reads it. A live read is the count; an answer that is no longer live is
 * the count `as of` its age; no answer at all is unknown, never a zero.
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
  const live = liveBusySessionCount({
    reportedCount: data?.busySessionCount ?? null,
    isError: status.isError,
    fetchStatus: status.fetchStatus,
    isStale: status.isStale,
    hasLiveSource: enabled && client !== null,
  });
  if (data !== null && live !== null) {
    return {
      report: { kind: "live", count: live, busy: data.busy },
      failed: false,
    };
  }
  if (data !== null && data.busySessionCount !== null) {
    return {
      report: {
        kind: "stale",
        count: data.busySessionCount,
        at: status.dataUpdatedAt,
      },
      failed: status.isError,
    };
  }
  return { report: { kind: "unknown" }, failed: status.isError };
}
