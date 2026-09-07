import { type ReactNode } from "react";
import { describeHostBusy } from "@/components/host/host-restart-copy";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  presentsLocalHostLifecycle,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";
import { createReportIssueContext } from "@/lib/report-issue-context";

/** The snapshot is categorical state only - never paths, error text or anything the user has to redact. Only
 * two of these four fallbacks are startup failures. */
export function hostFailureReportIssueAction(args: {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly source: string;
  readonly presentation: DefaultHostReadinessPresentation;
  /** Every other failure family passes false: the retained stage outlives its attempt (it is cleared only by a
   * new attempt or a successful settle), so a host that failed to install, came up by some other route. */
  readonly includeRetainedProgress: boolean;
}): ReactNode {
  return (
    <ReportIssueAction
      context={createReportIssueContext({
        title: args.title,
        message: `${args.message} ${describeHostHealth(
          args.presentation,
          args.includeRetainedProgress,
        )}`,
        code: args.code,
        source: args.source,
      })}
      presentation="text"
      className={undefined}
    />
  );
}

/** Everything here is a fixed vocabulary the renderer already holds - no new plumbing, and nothing that can
 * carry a filesystem path or a user's own data. */
function describeHostHealth(
  presentation: DefaultHostReadinessPresentation,
  includeRetainedProgress: boolean,
): string {
  const parts: string[] = [
    // A non-local target has no local host state to report, and it must say which non-local it is: "unknown" (the
    // app could not resolve the target entry) is a materially different triage story from a resolved remote.
    `host ${
      presentsLocalHostLifecycle(presentation)
        ? presentation.localHostState
        : presentation.targetKind
    }`,
    `compat ${describeCompatHealth(presentation)}`,
  ];
  if (presentation.provisioning) parts.push("provisioning");
  if (presentation.removed) parts.push("removed");
  if (presentation.hostBusy) parts.push("busy");
  if (presentation.stage === "slow") parts.push("slow start");
  // Fall back to the retained last event once the mutation has settled: a failed install's report must still say
  // where it died (traycer#862's report carried no stage at all because the live value nulls on settle).
  const progress =
    presentation.progress ??
    (includeRetainedProgress ? presentation.lastProgress : null);
  if (progress !== null) {
    const percent =
      progress.percent === null ? "" : ` ${Math.round(progress.percent)}%`;
    parts.push(`last progress ${progress.stage ?? "unknown"}${percent}`);
  }
  return `Host health: ${parts.join(", ")}.`;
}

function describeCompatHealth(
  presentation: DefaultHostReadinessPresentation,
): string {
  const compatibility = presentation.compatibility;
  const verdict = compatVerdict(compatibility);
  // The host's own last answer, not the desktop's converge outcome (that is the separate `hostBusy` part).
  const hostStatus = compatibility.hostStatus;
  if (hostStatus === null || !hostStatus.busy) return verdict;
  // An older host reports `busy` without a count. Say only what the host said. A typed breakdown names kinds; a
  // null one keeps the count copy, including the load-bearing "busy 0 sessions" vs "busy" split.
  const copy = describeHostBusy({
    breakdown: hostStatus.busyBreakdown,
    busySessionCount: hostStatus.busySessionCount,
    busy: hostStatus.busy,
  });
  if (
    hostStatus.busyBreakdown !== null &&
    copy.label !== null &&
    copy.label !== "Idle" &&
    copy.label !== "Busy"
  ) {
    return `${verdict}, busy ${copy.label}`;
  }
  const count = hostStatus.busySessionCount;
  if (count === null) return `${verdict}, busy`;
  return `${verdict}, busy ${count} ${count === 1 ? "session" : "sessions"}`;
}

function compatVerdict(
  compatibility: DefaultHostReadinessPresentation["compatibility"],
): string {
  if (compatibility.status === "failed") {
    return compatibility.unreachable ? "unreachable" : "rejected";
  }
  if (compatibility.status === "compatible" && compatibility.degraded) {
    return "compatible (degraded)";
  }
  return compatibility.status;
}
