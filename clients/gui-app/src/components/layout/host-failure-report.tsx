import { type ReactNode } from "react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  presentsLocalHostLifecycle,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";
import { createReportIssueContext } from "@/lib/report-issue-context";

/**
 * Standard "Report issue" affordance shown alongside the recovery actions on
 * the host-failure surfaces - the full-screen fallbacks
 * (provisioning-error, compatibility-error, incompatible-host,
 * slow/unavailable host) and, post-latch, the host status strip's error
 * variant, which is where those same failures now surface once the app has
 * been up.
 *
 * Every one of those used to file the SAME "Could not start Traycer Host"
 * report. On 2026-07-31 that single template produced three field reports with
 * identical titles and three completely unrelated causes - an offline host that
 * could not verify the session (traycer#858), a first install whose 60s
 * readiness budget expired mid-provisioning (traycer#862), and a host that had
 * been running and serving agent turns for hours (traycer#860). Each one cost a
 * full desktop+host log pull just to learn WHICH failure it was.
 *
 * So the pre-filled report now names its own failure family (`title`/`code`)
 * and carries a one-line health snapshot. The snapshot is categorical state
 * only - never paths, error text or anything the user has to redact.
 *
 * `source` is part of that discrimination, not decoration: it is the phase the
 * failure belongs to. Only two of these four fallbacks are startup failures.
 * A compatibility probe that stops answering is a host that already ran and
 * later went quiet - the traycer#860 shape - and filing that under "Host
 * startup" sends triage down the provisioning path, which is the exact wrong
 * place to look.
 *
 * Lives in its own module so the two renderers of these families - the
 * full-screen fallback mapping and the strip - file the SAME report from the
 * SAME health line. A second copy is a second chance to drift.
 */
export function hostFailureReportIssueAction(args: {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly source: string;
  readonly presentation: DefaultHostReadinessPresentation;
  /**
   * Whether this report is the one the retained install stage EXPLAINS - i.e.
   * the provisioning-error card, which by construction only renders while a
   * converge error is live (`readinessFor...`: `provisioningError !== null`).
   * Every other failure family passes false: the retained stage outlives its
   * attempt (it is cleared only by a new attempt or a successful settle), so a
   * host that failed to install, came up by some other route, and later went
   * incompatible would otherwise append a dead install stage to a report that
   * has nothing to do with provisioning - the same wrong-path triage that the
   * `source` split above exists to prevent.
   */
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

/**
 * One line of triage state for the pre-filled report: what the desktop shell
 * believed about the host at the moment the user filed. Everything here is a
 * fixed vocabulary the renderer already holds - no new plumbing, and nothing
 * that can carry a filesystem path or a user's own data.
 */
function describeHostHealth(
  presentation: DefaultHostReadinessPresentation,
  includeRetainedProgress: boolean,
): string {
  const parts: string[] = [
    // A non-local target has no local host state to report, and it must say
    // WHICH non-local it is: "unknown" (the app could not resolve the target
    // entry) is a materially different triage story from a resolved remote.
    // A local BOOT reports its local state even while the entry is
    // unresolved - that window is the first-install failure this line is
    // most often filed from.
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
  // Fall back to the retained last event once the mutation has settled: a
  // failed install's report must still say where it died (traycer#862's
  // report carried no stage at all because the live value nulls on settle).
  // Only for the report that failure belongs to - see
  // `includeRetainedProgress`.
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
  // The host's own last answer, not the desktop's converge outcome (that is
  // the separate `hostBusy` part): a host that reported itself busy serving
  // turns was up and working, whatever else this report says (traycer#860).
  const hostStatus = compatibility.hostStatus;
  if (hostStatus === null || !hostStatus.busy) return verdict;
  // An older host reports `busy` without a count. It used to arrive as a
  // fabricated `0`, which read as "busy 0 sessions"; it now arrives as `null`,
  // which would interpolate as the word "null" in a diagnostic someone pastes
  // into an issue. Say only what the host said.
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
