import type { ApplyHostOutcome } from "../installer/apply";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { resolveAttemptAdoptionFromNonce } from "../host/update-adoption";
import { hostHomeDir } from "../store/paths";
import { applyHostWithAttempt } from "../host/update-mutation";
import type { CommandFn, CommandResult } from "../runner/runner";

// Promote the staged host. Caller holds cli-lock. `--no-service` commits bytes without activating.
export interface HostApplyArgs {
  readonly force: boolean;
  readonly noService: boolean;
  readonly expectedStageFingerprint: string | null;
  /** Nonce naming a parent executor's live-lock proof, when this invocation was spawned from inside a held segment. `null` for every ordinary invocation, which keeps the acquire-or-refuse path exactly as it was. */
  readonly attemptAdoption: string | null;
}

export function buildHostApplyCommand(args: HostApplyArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host apply command started", {
      environment: ctx.runtime.environment,
      force: args.force,
      noService: args.noService,
    });
    const adoption = await resolveAttemptAdoptionFromNonce(
      hostHomeDir(ctx.runtime.environment),
      args.attemptAdoption,
      Date.now(),
    );
    // ONE options value for acquisition and revalidation: two literals that
    // must stay identical are how admission policies drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-apply",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "legacy-update-shadow",
      adoption,
    };
    const outcome = await withCliUpdateContender(
      contenderOptions,
      (capability) =>
        applyHostWithAttempt(capability, contenderOptions, {
          environment: ctx.runtime.environment,
          force: args.force,
          noService: args.noService,
          expectedStageFingerprint: args.expectedStageFingerprint,
          onProgress: (info) => ctx.progress(info),
        }),
    );
    const activation = activationOf(outcome);
    ctx.runtime.logger.info("Host apply command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
      activation,
    });
    return {
      // Additive sibling on the existing payload: every field callers already read is untouched, and `activation` collapses the three fields that answer "what happened to the service after the swap?" into one - the question exit 0 does NOT answer here.
      // See the success-contract note above, and `activationOf` for why it is not called "converged".
      data: { ...outcome, activation },
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

/** Service outcome after bytes committed, separate from apply success. Applied-but-not-converged is still exit 0. */
type ApplyActivation = "requested" | "failed" | "not-attempted" | null;

function activationOf(outcome: ApplyHostOutcome): ApplyActivation {
  if (outcome.outcome !== "applied") return null;
  if (outcome.postSwapError !== null) return "failed";
  return outcome.runningActivated ? "requested" : "not-attempted";
}

function humanSummary(outcome: ApplyHostOutcome): string {
  if (outcome.outcome === "no-op") {
    return `host already at ${outcome.installedVersion} (no-op)`;
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    return "staged host changed after eligibility; retry against the current stage";
  }
  // These lines report the ACTIVATION, never liveness - the same distinction `activation` draws in the payload, and for the same reason: nothing here probes health.
  // Saying "the host is NOT running" was the prose making the claim the field had just stopped making, and it can be flatly wrong - a bytes-only swap under a host nobody managed to stop leaves that host serving the old bytes, alive, while the start never ran.
  if (outcome.postSwapError !== null) {
    return `applied host ${outcome.record.version}, but the post-swap start/restart request failed: ${outcome.postSwapError} - liveness was not checked; run 'traycer host status' to see what is running, then 'traycer host doctor'`;
  }
  if (!outcome.runningActivated) {
    return `applied host ${outcome.record.version}, but no start was run, so the new bytes are not active yet - run 'traycer host status' to see what is running`;
  }
  return `applied host ${outcome.record.version} (previous: ${outcome.previous?.version ?? "none"})`;
}
