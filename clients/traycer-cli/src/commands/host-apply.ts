import { applyHost, type ApplyHostOutcome } from "../installer/apply";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// `traycer host apply [--force] [--no-service]` - promotes the single-slot
// staged tree over the current install (Host Update Layer Redesign Tech
// Plan, "New/changed commands" > `host apply`). The entire reconcile ->
// read-records -> no-op/busy-check -> commit flow runs inside ONE
// `cli-lock` acquisition - see `installer/apply.ts`'s `applyHost`, which
// assumes it is already running under the lock, same contract as
// `installHost`.
//
// `--no-service` is internal/hidden (the desktop-owned packaged-macOS
// path, which drives its own locked SMAppService activation cycle after a
// non-disruptive bytes-only apply) - see the registration site in
// `index.ts`.
//
// SUCCESS CONTRACT, and why it deliberately differs from `host update`'s.
// Exit 0 here means THE SWAP COMMITTED - not that the host came back. A
// post-swap service start that fails is reported as `postSwapError` on an
// `applied` outcome, per `applyHost`'s explicit no-rollback contract, and
// `runningActivated` says whether the new bytes are confirmed running.
//
// That is not an accident to be aligned away. `host apply` is the low-level
// primitive whose committed/not-committed answer callers need SEPARATELY from
// convergence: Desktop's `applyStagedCliOwned` reads `postSwapError` off this
// exit-0 envelope and renders "installed, not converged" with a Doctor
// pointer, and it reserves the thrown-error path for applies that did not
// commit at all (where its recovery is "retry with force"). Exiting non-zero
// on a failed post-swap start would route a committed swap into that
// wrong-recovery branch.
//
// `host update` is the composite and answers the other question - it stages,
// applies, then health-probes, and FAILS (`E_HOST_UPDATE_HEALTH_CHECK_FAILED`)
// when the updated host does not come back. A caller that wants "the host is
// running the new version or tell me it isn't" wants `host update`; a caller
// that wants "commit these bytes and report what happened" wants this. Both
// commands state that in their help; `converged` below makes the distinction
// readable from the payload without re-deriving it from three fields.
export interface HostApplyArgs {
  readonly force: boolean;
  readonly noService: boolean;
  readonly expectedStageFingerprint: string | null;
}

export function buildHostApplyCommand(args: HostApplyArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host apply command started", {
      environment: ctx.runtime.environment,
      force: args.force,
      noService: args.noService,
    });
    const outcome = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-apply",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        applyHost({
          environment: ctx.runtime.environment,
          force: args.force,
          noService: args.noService,
          expectedStageFingerprint: args.expectedStageFingerprint,
          onProgress: (info) => ctx.progress(info),
        }),
    );
    const converged = isConverged(outcome);
    ctx.runtime.logger.info("Host apply command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
      converged,
    });
    return {
      // Additive sibling on the existing payload: every field callers already
      // read is untouched, and `converged` is the single flag that answers
      // "is the host running the applied bytes?" - the question exit 0 does
      // NOT answer here. See the success-contract note above.
      data: { ...outcome, converged },
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

/**
 * Did this apply leave the host running the bytes it committed?
 *
 * `null`, NOT `false`, for every outcome that committed nothing. A `no-op`
 * (nothing staged, install already current) and a `stage-fingerprint-mismatch`
 * both return without probing or touching the running host, so this command
 * holds no evidence either way - and a healthy, already-running installation
 * reported as `converged: false` is a claim it never made. Three states,
 * because there are three: converged, demonstrably not converged, and not
 * asked.
 */
function isConverged(outcome: ApplyHostOutcome): boolean | null {
  if (outcome.outcome !== "applied") return null;
  return outcome.postSwapError === null && outcome.runningActivated;
}

function humanSummary(outcome: ApplyHostOutcome): string {
  if (outcome.outcome === "no-op") {
    return `host already at ${outcome.installedVersion} (no-op)`;
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    return "staged host changed after eligibility; retry against the current stage";
  }
  // Both non-converged lines name the state the machine is actually in and
  // what to do about it. "Applied" alone reads as done, and this command
  // exits 0 either way, so the text is the only thing distinguishing them.
  if (outcome.postSwapError !== null) {
    return `applied host ${outcome.record.version}, but the host is NOT running: the service did not come back after the swap: ${outcome.postSwapError} - run 'traycer host doctor'`;
  }
  if (!outcome.runningActivated) {
    return `applied host ${outcome.record.version}, but the host is NOT running yet: activation still required`;
  }
  return `applied host ${outcome.record.version} (previous: ${outcome.previous?.version ?? "none"})`;
}
