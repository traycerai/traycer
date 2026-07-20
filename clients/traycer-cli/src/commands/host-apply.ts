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
    ctx.runtime.logger.info("Host apply command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
    });
    return {
      data: outcome,
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

function humanSummary(outcome: ApplyHostOutcome): string {
  if (outcome.outcome === "no-op") {
    return `host already at ${outcome.installedVersion} (no-op)`;
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    return "staged host changed after eligibility; retry against the current stage";
  }
  if (outcome.postSwapError !== null) {
    return `applied host ${outcome.record.version}; service did not converge: ${outcome.postSwapError}`;
  }
  if (!outcome.runningActivated) {
    return `applied host ${outcome.record.version}; activation still required`;
  }
  return `applied host ${outcome.record.version} (previous: ${outcome.previous?.version ?? "none"})`;
}
